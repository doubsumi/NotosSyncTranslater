// ---------------------------------------------------------------------------
// SyncController — the brain of the two-way live translator (v3).
//
// Queue-based incremental model (aligned with the product spec):
//
//   * Every pane is its own *document* (`docId`). When the user edits a pane
//     it becomes the source; the other pane becomes the mirror.
//   * Source text is segmented into sentence units with stable numeric ids
//     (`sid`). Edits preserve the ids of every unchanged sentence via a
//     prefix/suffix anchor diff; only inserted/re-written sentences change.
//   * Mirror-first rendering: the target pane first shows a verbatim mirror of
//     the source (every sentence is its own placeholder), then each sentence
//     is submitted to the backend queue *one by one* (`sid` addressing) and
//     flips to its translation as its result arrives — the frontend only ever
//     replaces the text of that one id.
//   * On edit the frontend submits ONLY the edited sentence's `sid` (+text);
//     the backend answers that id and the frontend updates just that region.
//   * Per-pane documents let both sides be edited independently; while the
//     user types in a pane, writes from the other direction are cancelled and
//     never overwrite what they are editing.
// ---------------------------------------------------------------------------

import { mapBlocks, splitBlocks, splitRequestUnits } from "./blocks";
import { defaultTargetFor, detectLanguage, type LangCode } from "./detection";
import { debounce, type Debounced } from "./debounce";
import { type Api, type SegSyncResult } from "./api";

export type Side = "left" | "right";
export const opposite = (side: Side): Side => (side === "left" ? "right" : "left");

export interface PaneState {
  text: string;
  /** Selected code; "auto" means auto-detect. */
  lang: LangCode;
  /** Detected language when `lang === "auto"` ("auto" = not yet known). */
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
  /** How many sentence requests may fly concurrently (per sentence). */
  concurrency?: number;
}

/** One aligned sentence: character range in both panes. */
export interface AlignRow {
  srcS: number;
  srcE: number;
  dstS: number;
  dstE: number;
}

export interface Alignment {
  /** The pane holding the *source* text of the pair. */
  srcSide: Side;
  rows: AlignRow[];
}

interface Slot {
  sid: number;
  text: string;
  translated: string | null;
  provider: string;
}

interface Doc {
  docId: string;
  from: LangCode;
  to: LangCode;
  sidSeq: number;
  slots: Slot[];
}

export interface ComposeResult {
  text: string;
  rows: AlignRow[];
}

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

/** Pure pair computation shared by the controller and the UI labels. */
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

// ---------------------------------------------------------------------------
// Pure mirror composition (also exported for tests).
// ---------------------------------------------------------------------------
/**
 * Build the target text from source layout + per-slot resolution. When a slot
 * has no translation yet its source text is used (the placeholder), so the
 * mirror starts as a verbatim copy of the source and flips sentence by
 * sentence. Newlines/layout of the source are preserved verbatim.
 */
export function composeMirrorInternal(
  srcText: string,
  resolve: () => string | null
): ComposeResult {
  let out = "";
  let cursor = 0;
  const rows: AlignRow[] = [];
  let dstPos = 0;
  for (const [bStart, bEnd] of mapBlocks(srcText)) {
    out += srcText.slice(cursor, bStart);
    const content = srcText.slice(bStart, bEnd);
    const units = splitRequestUnits(content);
    let srcLocal = 0;
    for (const unit of units) {
      const resolved = resolve();
      const shown = resolved ?? unit.text;
      const srcS = bStart + srcLocal;
      const srcE = srcS + unit.text.length;
      out += shown;
      out += unit.ws;
      const dstS = dstPos;
      const dstE = dstS + shown.length;
      dstPos = dstE + unit.ws.length;
      rows.push({ srcS, srcE, dstS, dstE });
      srcLocal += unit.text.length + unit.ws.length;
    }
    cursor = bEnd;
  }
  out += srcText.slice(cursor);
  return { text: out, rows };
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

  private docs: Record<Side, Doc | null> = { left: null, right: null };
  /** Side whose text is the source of the currently aligned pair. */
  private mappingSide: Side | null = null;
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
  // Public actions
  // ------------------------------------------------------------------
  edit(side: Side, text: string): void {
    const pane = this.state[side];
    this.setState((s) => ({
      ...s,
      [side]: { ...pane, text, detected: this.refreshDetected(side, text) },
      active: side,
    }));
    if (this.mappingSide !== side) {
      // The user switched which side they edit: stop the other direction.
      this.mappingSide = null;
      this.cancelQueued();
    }
    this.schedule();
  }

  changeLang(side: Side, lang: LangCode): void {
    const pane = this.state[side];
    this.setState((s) => ({
      ...s,
      [side]: {
        ...pane,
        lang,
        detected:
          lang === "auto" ? this.refreshDetected(side, pane.text) : pane.detected,
      },
    }));
    this.cancelQueued();
    const active = this.state.active;
    if (active) this.runNow();
  }

  swap(): void {
    const s = this.state;
    this.cancelQueued();
    this.mappingSide = null;
    this.docs.left = null;
    this.docs.right = null;
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
    this.mappingSide = null;
    this.docs.left = null;
    this.docs.right = null;
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

  /** Re-run synchronisation (used by error-retry toasts). */
  retry(): void {
    const active = this.state.active;
    if (!active) return;
    this.runNow();
  }

  /** Full re-sync: every sentence is re-queued under a fresh document. */
  retranslateAll(): void {
    const active = this.state.active;
    if (!active) return;
    this.cancelQueued();
    this.mappingSide = null;
    this.docs[active] = null;
    this.runNow();
  }

  /** Load a previously persisted session without triggering translation. */
  restore(left: PaneState, right: PaneState): void {
    this.cancelQueued();
    this.mappingSide = null;
    this.docs.left = null;
    this.docs.right = null;
    this.setState((s) => ({ ...s, left, right, active: null }));
  }

  dispose(): void {
    this.debounced.cancel();
    this.cancelQueued();
  }

  /**
   * Exact sentence alignment of the displayed pair, or null when the target
   * pane is not byte-identical to the current mirror composition (e.g. the
   * target was hand-edited or a sync is still mid-flight).
   */
  alignFor(selectedSide: Side): Alignment | null {
    const srcSide = this.mappingSide;
    if (!srcSide) return null;
    if (selectedSide !== srcSide && selectedSide !== opposite(srcSide)) return null;
    const src = this.state[srcSide];
    const dst = this.state[opposite(srcSide)];
    if (!src.text.trim()) return null;
    const composed = this.composeMirror(srcSide, src.text);
    if (composed.text !== dst.text) return null;
    return { srcSide, rows: composed.rows };
  }

  // ------------------------------------------------------------------
  // Internals
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
    this.debounced.schedule(() => {
      void this.run(false);
    });
  }

  private runNow(): void {
    this.debounced.cancel();
    void this.run(false);
  }

  private cancelQueued(): void {
    if (this.aborter) {
      this.aborter.abort();
      this.aborter = null;
    }
  }

  /** Compose the mirror for the currently stored doc of `srcSide`. */
  private composeMirror(srcSide: Side, srcText: string): ComposeResult {
    const doc = this.docs[srcSide];
    let idx = 0;
    return composeMirrorInternal(srcText, () => {
      const slot = doc?.slots[idx];
      idx++;
      return slot ? slot.translated : null;
    });
  }

  /** Compose from an explicit slot list (used right after rebuilding). */
  private rebuildCompose(srcText: string, slots: readonly Slot[]): ComposeResult {
    let idx = 0;
    return composeMirrorInternal(srcText, () => slots[idx++]?.translated ?? null);
  }

  // ------------------------------------------------------------------
  // Core sync
  // ------------------------------------------------------------------
  private async run(force = false): Promise<void> {
    const active = this.state.active;
    if (!active) return;
    this.cancelQueued();
    this.generation++;
    const src = this.state[active];
    const dstSide = opposite(active);
    const target = this.state[dstSide];
    const srcText = src.text;

    if (srcText.length > 0 && target.text === srcText) {
      this.clearBusy();
      return;
    }
    if (srcText.trim().length === 0) {
      if (target.text.length > 0) this.applyTo(dstSide, "");
      this.docs[active] = null;
      this.mappingSide = null;
      this.setState((s) => ({
        ...s,
        phase: "idle",
        statusText: null,
        progress: null,
        left: { ...s.left, busy: false },
        right: { ...s.right, busy: false },
      }));
      return;
    }

    const pair = computePair(src, target, srcText);
    if (pair.to === "auto") {
      this.clearBusy();
      return;
    }

    // Rebuild the doc: keep sids stable for unchanged sentences.
    const { doc, changed } = this.buildDoc(active, pair, srcText, force);
    this.docs[active] = doc;

    // Mirror-first: the target pane shows the placeholder document before
    // any network result arrives.
    const composed = this.rebuildCompose(srcText, doc.slots);
    if (composed.text !== target.text) {
      this.applyTo(dstSide, composed.text);
    }
    if (this.state[active].text !== srcText) return; // user typed meanwhile

    if (changed.length === 0) {
      this.mappingSide = active;
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

    await this.streamSegments({ active, dstSide, doc, changed });
  }

  /**
   * Re-segment the source and assign stable sids. Unchanged sentences (by the
   * prefix/suffix anchor diff) keep their ids and cached translations.
   */
  private buildDoc(
    side: Side,
    pair: Pair,
    text: string,
    force: boolean
  ): { doc: Doc; changed: number[] } {
    const prev = this.docs[side];
    const units = this.unitsOf(text);
    const prevUsable =
      prev !== null &&
      !force &&
      prev.from === pair.from &&
      prev.to === pair.to &&
      prev.slots.length > 0;
    const docId = prevUsable ? prev.docId : newDocId();

    if (!prevUsable) {
      const slots: Slot[] = units.map((t, i) => ({
        sid: i,
        text: t,
        translated: null,
        provider: "",
      }));
      return {
        doc: { docId, from: pair.from, to: pair.to, sidSeq: units.length, slots },
        changed: slots.map((_, i) => i),
      };
    }

    const prevUnits = prev.slots.map((s) => s.text);
    const n = prevUnits.length;
    const m = units.length;
    let lo = 0;
    while (lo < n && lo < m && prevUnits[lo] === units[lo]) lo++;
    let hiN = n;
    let hiM = m;
    while (hiN > lo && hiM > lo && prevUnits[hiN - 1] === units[hiM - 1]) {
      hiN--;
      hiM--;
    }

    const changed: number[] = [];
    const outSlots: Slot[] = [];
    // Prefix: identical -> reuse old slots unchanged.
    for (let i = 0; i < lo; i++) outSlots.push(prev.slots[i]);
    // Middle.
    const oldMid = hiN - lo;
    const newMid = hiM - lo;
    let counter = prev.sidSeq;
    if (newMid === oldMid) {
      // Pure rewrite(s) inside the middle: slots keep their sids.
      for (let i = lo; i < hiM; i++) {
        const oldSlot = prev.slots[i];
        const sameText = oldSlot.text === units[i];
        const translated = sameText ? oldSlot.translated : null;
        outSlots.push({
          sid: oldSlot.sid,
          text: units[i],
          translated,
          provider: sameText ? oldSlot.provider : "",
        });
        if (!sameText || translated === null) changed.push(i);
      }
    } else {
      // Insertion/deletion of whole sentences: new sids for the middle.
      for (let i = lo; i < hiM; i++) {
        outSlots.push({
          sid: counter++,
          text: units[i],
          translated: null,
          provider: "",
        });
        changed.push(i);
      }
    }
    // Suffix: identical -> reuse old slots.
    for (let i = hiM; i < m; i++) {
      outSlots.push(prev.slots[hiN + (i - hiM)]);
    }

    return {
      doc: { docId, from: pair.from, to: pair.to, sidSeq: counter, slots: outSlots },
      changed,
    };
  }

  private unitsOf(text: string): string[] {
    const out: string[] = [];
    for (const block of splitBlocks(text)) {
      for (const unit of splitRequestUnits(block)) out.push(unit.text);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Streaming submission — one request per sentence, bounded concurrency
  // ------------------------------------------------------------------
  private async streamSegments(args: {
    active: Side;
    dstSide: Side;
    doc: Doc;
    changed: number[];
  }): Promise<void> {
    const { active, dstSide, doc, changed } = args;
    const gen = ++this.generation;
    const aborter = new AbortController();
    this.aborter = aborter;
    this.startedAt = performance.now();
    const srcSnapshot = this.state[active].text;

    const total = changed.length;
    let done = 0;
    let failed = 0;
    let lastProvider: string | null = null;
    let firstError = "";

    this.setState((s) => ({
      ...s,
      phase: "translating",
      statusText: `正在翻译 0/${total} 句`,
      progress: { done: 0, total },
      [dstSide]: { ...s[dstSide], busy: true },
    }));

    const applyMirror = (): void => {
      const nowSrc = this.state[active];
      if (this.state.active !== active || nowSrc.text !== srcSnapshot) return;
      const composed = this.rebuildCompose(srcSnapshot, doc.slots);
      if (this.state[dstSide].text !== composed.text) {
        this.applyTo(dstSide, composed.text);
      }
    };
    applyMirror();

    const queue = changed.slice();
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.generation !== gen) return;
        const slotIdx = queue.shift();
        if (slotIdx === undefined) return;
        const slot = doc.slots[slotIdx];
        const alive = doc.slots.map((s) => s.sid);

        let result: SegSyncResult;
        try {
          const responses = await this.api.syncDocSegments(
            doc.docId,
            doc.from,
            doc.to,
            [{ sid: slot.sid, text: slot.text }],
            alive,
            aborter.signal
          );
          result = responses[0];
        } catch (err) {
          if (this.generation !== gen) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          result = {
            sid: slot.sid,
            ok: false,
            error: {
              code: "NETWORK",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        if (this.generation !== gen) return;

        if (result.ok && result.translated !== undefined) {
          slot.translated = result.translated;
          slot.provider = result.provider ?? "";
          lastProvider = lastProvider ?? (result.provider ?? null);
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
        applyMirror();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, total) }, () => worker())
    );
    if (this.generation !== gen) return;

    this.aborter = null;
    this.mappingSide = active;
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

  private applyTo(dst: Side, text: string): void {
    const pane = this.state[dst];
    if (pane.text === text) return;
    this.setState((s) => ({
      ...s,
      [dst]: { ...pane, text },
      statusText: s.statusText,
    }));
  }
}
