// ---------------------------------------------------------------------------
// SyncController (v6) — bilingual segment-table architecture.
//
// Model
// -----
// The document is an ordered token list: sentence tokens (each with a stable
// segment id) interleaved with separator tokens (whitespace/newlines). Every
// segment stores BOTH language texts (`L` and `R`); the two panes are just
// two views over the same table:
//     left  = join of segment.L + separators
//     right = join of segment.R + separators
//
// Editing either pane maps back to token-level CRUD (see lib/tokens.ts):
//   * unchanged sentences keep their id and their counterpart translation;
//   * an edited sentence keeps its id, clears only its counterpart, and is
//     re-translated alone;
//   * inserted/deleted sentences add/remove the shared segment at the same
//     position on both sides.
//
// Because rendering derives from the segment table, an update to one sentence
// changes exactly that sentence's span in the editor (minimal diff) — there
// is no whole-document recomposition, no direction special-casing, no
// truncation.
// ---------------------------------------------------------------------------

import { defaultTargetFor, detectLanguage, type LangCode } from "./detection";
import { debounce, type Debounced } from "./debounce";
import { alignTokenLists, tokenize, type RawToken } from "./tokens";
import { type Api, type SegSyncResult } from "./api";

export type Side = "left" | "right";
export const opposite = (side: Side): Side => (side === "left" ? "right" : "left");

export interface PaneState {
  text: string;
  lang: LangCode;
  detected: LangCode;
  busy: boolean;
}

export interface Pair {
  from: LangCode;
  to: LangCode;
}

export interface ProgressState {
  done: number;
  total: number;
}

export interface ControllerState {
  left: PaneState;
  right: PaneState;
  active: Side | null;
  phase: "idle" | "translating";
  statusText: string | null;
  provider: string | null;
  lastElapsedMs: number | null;
  progress: ProgressState | null;
}

export interface ToastMessage {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ControllerOptions {
  api: Api;
  onUpdate: (state: ControllerState) => void;
  onToast: (toast: ToastMessage) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  concurrency?: number;
}

export interface AlignRow {
  srcS: number;
  srcE: number;
  dstS: number;
  dstE: number;
}

export interface Alignment {
  srcSide: Side;
  rows: AlignRow[];
}

interface Segment {
  id: number;
  L: string;
  R: string;
}

type Token = { type: "text"; id: number } | { type: "sep"; text: string };

const EMPTY_PANE = (): PaneState => ({
  text: "",
  lang: "auto",
  detected: "auto",
  busy: false,
});

function newDocId(): string {
  try {
    return `nst-${crypto.randomUUID()}`;
  } catch {
    return `nst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function computePair(
  source: Pick<PaneState, "text" | "lang" | "detected">,
  target: Pick<PaneState, "lang">,
  text: string = source.text
): Pair {
  const detected =
    source.detected !== "auto" ? source.detected : detectLanguage(text).code;
  const from: LangCode = source.lang !== "auto" ? source.lang : detected;
  let to: LangCode;
  if (target.lang !== "auto") {
    to = target.lang;
  } else {
    const base = from !== "auto" ? from : detected;
    to = base !== "auto" ? defaultTargetFor(base) : "zh";
  }
  return { from, to };
}

export class SyncController {
  private readonly api: Api;
  private readonly onUpdate: (state: ControllerState) => void;
  private readonly onToast: (toast: ToastMessage) => void;
  private readonly concurrency: number;
  private readonly debounced: Debounced;

  private state: ControllerState = {
    left: EMPTY_PANE(),
    right: EMPTY_PANE(),
    active: null,
    phase: "idle",
    statusText: null,
    provider: null,
    lastElapsedMs: null,
    progress: null,
  };

  // ---- segment table -----------------------------------------------------
  private tokens: Token[] = [];
  private segs = new Map<number, Segment>();
  private nextId = 1;
  private docIds: Record<Side, string | null> = { left: null, right: null };
  private generation = 0;
  private aborter: AbortController | null = null;
  private toastSeq = 0;
  private startedAt = 0;

  constructor(opts: ControllerOptions) {
    this.api = opts.api;
    this.onUpdate = opts.onUpdate;
    this.onToast = opts.onToast;
    this.concurrency = Math.min(Math.max(opts.concurrency ?? 3, 1), 8);
    this.debounced = debounce(opts.debounceMs ?? 800, opts.maxWaitMs ?? 2600);
  }

  // ------------------------------------------------------------------
  edit(side: Side, text: string): void {
    const pane = this.state[side];
    this.setState((s) => ({
      ...s,
      [side]: { ...pane, text, detected: this.refreshDetected(side, text) },
      active: side,
    }));
    this.schedule();
  }

  changeLang(side: Side, lang: LangCode): void {
    const pane = this.state[side];
    this.setState((s) => ({
      ...s,
      [side]: {
        ...pane,
        lang,
        detected: lang === "auto" ? this.refreshDetected(side, pane.text) : pane.detected,
      },
    }));
    if (this.state.active) this.runNow();
  }

  swap(): void {
    const s = this.state;
    this.cancelQueued();
    this.resetTable();
    this.setState((st) => ({
      ...st,
      left: { ...s.right, busy: false },
      right: { ...s.left, busy: false },
      active: "left",
      statusText: null,
      progress: null,
    }));
    this.runNow();
  }

  clear(): void {
    this.cancelQueued();
    this.debounced.cancel();
    this.generation++;
    this.resetTable();
    this.setState((s) => ({
      ...s,
      left: { ...s.left, text: "", detected: "auto", busy: false },
      right: { ...s.right, text: "", detected: "auto", busy: false },
      active: null,
      phase: "idle",
      statusText: null,
      progress: null,
      provider: null,
      lastElapsedMs: null,
    }));
  }

  retry(): void {
    if (this.state.active) this.runNow();
  }

  retranslateAll(): void {
    const side = this.state.active;
    if (!side) return;
    // Clear every counterpart and re-translate the whole source side.
    for (const seg of this.segs.values()) {
      if (side === "left") seg.R = "";
      else seg.L = "";
    }
    const ids = this.tokenIds();
    this.renderAndApply();
    void this.streamTranslations(side, ids);
  }

  restore(left: PaneState, right: PaneState): void {
    this.cancelQueued();
    this.resetTable();
    this.setState((s) => ({ ...s, left, right, active: null }));
  }

  dispose(): void {
    this.debounced.cancel();
    this.cancelQueued();
  }

  /**
   * Exact sentence alignment for cross-pane highlight/linking. Rows are
   * derived directly from the segment table (one row per sentence id).
   */
  alignFor(_selectedSide: Side): Alignment | null {
    if (!this.segs.size) return null;
    const rendered = this.renderWithOffsets();
    if (rendered.left !== this.state.left.text || rendered.right !== this.state.right.text) {
      return null;
    }
    return { srcSide: "left", rows: rendered.rows };
  }

  // ------------------------------------------------------------------
  private setState(mutate: (s: ControllerState) => ControllerState): void {
    this.state = mutate(this.state);
    this.onUpdate(this.state);
  }

  private refreshDetected(side: Side, text: string): LangCode {
    if (this.state[side].lang !== "auto") return this.state[side].detected;
    return text.trim().length > 0 ? detectLanguage(text).code : "auto";
  }

  private clearBusy(): void {
    this.setState((s) => ({
      ...s,
      left: { ...s.left, busy: false },
      right: { ...s.right, busy: false },
    }));
  }

  private schedule(): void {
    this.debounced.cancel();
    this.debounced.schedule(() => void this.run());
  }

  private runNow(): void {
    this.debounced.cancel();
    void this.run();
  }

  private cancelQueued(): void {
    if (this.aborter) {
      this.aborter.abort();
      this.aborter = null;
    }
  }

  private resetTable(): void {
    this.tokens = [];
    this.segs.clear();
    this.nextId = 1;
  }

  private tokenIds(): number[] {
    const out: number[] = [];
    for (const t of this.tokens) if (t.type === "text") out.push(t.id);
    return out;
  }

  private segField(side: Side): "L" | "R" {
    return side === "left" ? "L" : "R";
  }

  private renderSide(side: Side): string {
    const field = this.segField(side);
    let out = "";
    for (const t of this.tokens) {
      if (t.type === "sep") out += t.text;
      else out += this.segs.get(t.id)?.[field] ?? "";
    }
    return out;
  }

  private renderWithOffsets(): { left: string; right: string; rows: AlignRow[] } {
    let l = "";
    let r = "";
    const rows: AlignRow[] = [];
    for (const t of this.tokens) {
      if (t.type === "sep") {
        l += t.text;
        r += t.text;
        continue;
      }
      const seg = this.segs.get(t.id);
      const ls = l.length;
      const rs = r.length;
      const lt = seg?.L ?? "";
      const rt = seg?.R ?? "";
      l += lt;
      r += rt;
      rows.push({ srcS: ls, srcE: ls + lt.length, dstS: rs, dstE: rs + rt.length });
    }
    return { left: l, right: r, rows };
  }

  private applyPane(side: Side, text: string): void {
    const pane = this.state[side];
    if (pane.text === text) return;
    this.setState((s) => ({
      ...s,
      [side]: { ...pane, text },
      statusText: s.statusText,
    }));
  }

  private renderAndApply(): void {
    this.applyPane("left", this.renderSide("left"));
    this.applyPane("right", this.renderSide("right"));
  }

  // ------------------------------------------------------------------
  private async run(): Promise<void> {
    const side = this.state.active;
    if (!side) return;
    this.cancelQueued();
    this.generation++;
    const src = this.state[side];
    const otherSide = opposite(side);
    const other = this.state[otherSide];
    const srcText = src.text;

    if (srcText.length > 0 && other.text === srcText) {
      this.clearBusy();
      return;
    }
    if (srcText.trim().length === 0) {
      this.resetTable();
      this.setState((s) => ({
        ...s,
        phase: "idle",
        statusText: null,
        progress: null,
        left: { ...s.left, busy: false, text: "" },
        right: { ...s.right, busy: false, text: "" },
      }));
      return;
    }

    const pair = computePair(src, other, srcText);
    if (pair.to === "auto") {
      this.clearBusy();
      return;
    }

    // ---- token-level CRUD ---------------------------------------------
    const nextRaw = tokenize(srcText);
    const { tokens: nextTokens, changedIds, addedIds, removedIds } = this.applyTokenEdit(
      side,
      nextRaw
    );
    for (const id of removedIds) this.segs.delete(id);
    this.tokens = nextTokens;

    const pending = [...new Set([...addedIds, ...changedIds])];
    const field = this.segField(side);
    const otherField = this.segField(otherSide);
    for (const id of pending) {
      const seg = this.segs.get(id);
      if (seg) seg[otherField] = "";
    }
    this.renderAndApply();

    if (pending.length === 0) {
      this.setState((s) => ({
        ...s,
        phase: "idle",
        statusText: "已同步",
        progress: null,
        left: { ...s.left, busy: false },
        right: { ...s.right, busy: false },
      }));
      return;
    }

    // Every changed/inserted sentence is submitted with its own id.
    const requested = pending.filter((id) => {
      const seg = this.segs.get(id);
      return seg !== undefined && (seg[field] ?? "").length > 0;
    });
    await this.streamTranslations(side, requested);
  }

  /**
   * Align the existing token table against the edited side's new tokens.
   * Returns the new token list plus the changed/added/removed segment ids.
   */
  private applyTokenEdit(
    side: Side,
    nextRaw: RawToken[]
  ): { tokens: Token[]; changedIds: number[]; addedIds: number[]; removedIds: number[] } {
    const field = this.segField(side);
    const oldRaw: RawToken[] = this.tokens.map((t) =>
      t.type === "text" ? { type: "text", text: this.segs.get(t.id)?.[field] ?? "" } : t
    );

    // Prefix / suffix trim (identical tokens keep id & layout).
    let lo = 0;
    while (
      lo < oldRaw.length &&
      lo < nextRaw.length &&
      oldRaw[lo].type === nextRaw[lo].type &&
      oldRaw[lo].text === nextRaw[lo].text
    ) {
      lo++;
    }
    let hiOld = oldRaw.length;
    let hiNew = nextRaw.length;
    while (
      hiOld > lo &&
      hiNew > lo &&
      oldRaw[hiOld - 1].type === nextRaw[hiNew - 1].type &&
      oldRaw[hiOld - 1].text === nextRaw[hiNew - 1].text
    ) {
      hiOld--;
      hiNew--;
    }

    const oldMid = oldRaw.slice(lo, hiOld);
    const newMid = nextRaw.slice(lo, hiNew);
    const changedIds: number[] = [];
    const addedIds: number[] = [];
    const removedIds: number[] = [];

    // Middle: pairwise replace when counts match (keeps id on edits), else
    // LCS-based insert/delete.
    const middleTokens: Token[] = [];
    if (oldMid.length === newMid.length) {
      for (let i = 0; i < newMid.length; i++) {
        const o = oldMid[i];
        const n = newMid[i];
        const oldTok = this.tokens[lo + i];
        if (n.type === "sep") {
          middleTokens.push({ type: "sep", text: n.text });
          if (o.type === "text" && oldTok.type === "text") removedIds.push(oldTok.id);
          continue;
        }
        if (o.type === "text" && oldTok.type === "text") {
          if (o.text !== n.text) {
            const seg = this.segs.get(oldTok.id);
            if (seg) seg[field] = n.text;
            changedIds.push(oldTok.id);
          }
          middleTokens.push({ type: "text", id: oldTok.id });
        } else {
          // Structure mismatch inside equal-length middle: treat as insert.
          const id = this.nextId++;
          this.segs.set(id, { id, L: "", R: "" });
          (this.segs.get(id) as Segment)[field] = n.text;
          addedIds.push(id);
          middleTokens.push({ type: "text", id });
        }
      }
    } else {
      const { matched, oldOnly } = alignTokenLists(oldMid, newMid);
      const byNew = new Map(matched.map(([oi, ni]) => [ni, oi]));
      const matchedOld = new Set(matched.map(([oi]) => oi));
      for (let ni = 0; ni < newMid.length; ni++) {
        const n = newMid[ni];
        const oi = byNew.get(ni);
        if (oi !== undefined) {
          const o = oldMid[oi];
          const oldTok = this.tokens[lo + oi];
          if (n.type === "text" && o.type === "text" && oldTok.type === "text") {
            middleTokens.push({ type: "text", id: oldTok.id });
          } else {
            middleTokens.push({ type: "sep", text: n.text });
          }
          continue;
        }
        if (n.type === "sep") {
          middleTokens.push({ type: "sep", text: n.text });
        } else {
          const id = this.nextId++;
          this.segs.set(id, { id, L: "", R: "" });
          (this.segs.get(id) as Segment)[field] = n.text;
          addedIds.push(id);
          middleTokens.push({ type: "text", id });
        }
      }
      for (const oi of oldOnly) {
        if (!matchedOld.has(oi) && oldMid[oi].type === "text") {
          const oldTok = this.tokens[lo + oi];
          if (oldTok.type === "text") removedIds.push(oldTok.id);
        }
      }
    }

    // Reassemble.
    const out: Token[] = [];
    for (let i = 0; i < lo; i++) {
      const t = this.tokens[i];
      out.push(t);
    }
    out.push(...middleTokens);
    for (let i = hiOld; i < this.tokens.length; i++) {
      out.push(this.tokens[i]);
    }
    return { tokens: out, changedIds, addedIds, removedIds };
  }

  // ------------------------------------------------------------------
  private docId(side: Side): string {
    if (!this.docIds[side]) this.docIds[side] = newDocId();
    return this.docIds[side] as string;
  }

  private async streamTranslations(side: Side, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const gen = ++this.generation;
    const aborter = new AbortController();
    this.aborter = aborter;
    this.startedAt = performance.now();
    const otherSide = opposite(side);
    const field = this.segField(side);
    const otherField = this.segField(otherSide);
    const src = this.state[side];
    const pair = computePair(src, this.state[otherSide], src.text);
    const alive = this.tokenIds();

    const total = ids.length;
    let done = 0;
    let failed = 0;
    let lastProvider: string | null = null;
    let firstError = "";

    this.setState((s) => ({
      ...s,
      phase: "translating",
      statusText: `正在翻译 0/${total} 句`,
      progress: { done: 0, total },
      [otherSide]: { ...s[otherSide], busy: true },
    }));

    const queue = ids.slice();
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.generation !== gen) return;
        const id = queue.shift();
        if (id === undefined) return;
        const seg = this.segs.get(id);
        if (!seg) {
          done++;
          continue;
        }
        const text = seg[field];
        let result: SegSyncResult;
        try {
          const res = await this.api.syncDocSegments(
            this.docId(side),
            pair.from,
            pair.to,
            [{ sid: id, text }],
            alive,
            aborter.signal
          );
          result = res[0];
        } catch (err) {
          if (this.generation !== gen) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          result = {
            sid: id,
            ok: false,
            error: { code: "NETWORK", message: err instanceof Error ? err.message : String(err) },
          };
        }
        if (this.generation !== gen) return;
        if (result.ok && result.translated !== undefined) {
          seg[otherField] = result.translated;
          lastProvider = lastProvider ?? result.provider ?? null;
        } else {
          failed++;
          firstError = firstError || result.error?.message || "翻译失败";
        }
        done++;
        this.setState((s) => ({
          ...s,
          statusText: `正在翻译 ${done}/${total} 句`,
          progress: { done, total },
        }));
        this.renderAndApply();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, total) }, () => worker())
    );
    if (this.generation !== gen) return;
    this.aborter = null;
    const elapsed = Math.round(performance.now() - this.startedAt);
    this.setState((s) => ({
      ...s,
      phase: "idle",
      progress: null,
      left: { ...s.left, busy: false },
      right: { ...s.right, busy: false },
      provider: failed > 0 ? s.provider : lastProvider ?? s.provider,
      statusText:
        failed > 0
          ? "部分句子翻译失败"
          : total > 1
            ? `已同步 ${total} 句`
            : lastProvider
              ? `已由 ${lastProvider} 翻译 · ${elapsed} ms`
              : "已同步",
    }));
    if (failed > 0) {
      this.onToast({
        id: ++this.toastSeq,
        kind: "error",
        message:
          failed >= total
            ? firstError || "翻译失败，请重试"
            : `有 ${failed} 句翻译失败，其余已同步`,
        actionLabel: "重试",
        onAction: () => this.retry(),
      });
    }
  }
}
