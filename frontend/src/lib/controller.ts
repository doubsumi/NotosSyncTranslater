// ---------------------------------------------------------------------------
// SyncController — the brain of the two-way live translator.
//
// Incremental design (see README "research" for why this is the commercial
// pattern):
//   document → blocks (1:1 line layout) → bounded sentence units (≤400 chars)
// The units are the request/TM granularity. On every edit the controller
// re-segments the source and asks the server for *only the units whose text
// is not in translation memory* — a local edit re-sends a handful of small
// sentences, never a whole paragraph, and no single request can grow without
// bound (root cause of long waits / timeouts on dense unpunctuated text).
//
// Additional guarantees (unit-tested):
//   2. Debounce (800 ms trailing, 2.6 s max-wait) + stale-work cancellation.
//   3. Bounded waves with per-wave timeout self-healing: if a whole wave
//      fails/times out, it is retried one item at a time so one bad sentence
//      cannot stall the rest or blow the request timeout.
//   4. Exact sentence mapping (`alignFor`) so the UI can highlight the
//      corresponding original/translation sentence in the other pane.
//   5. Results never overwrite text the user is editing; failures surface as
//      retryable toasts, never as inline errors.
// ---------------------------------------------------------------------------

import {
  composeUnits,
  mapBlocks,
  rebuildWithResolver,
  splitBlocks,
  splitRequestUnits,
} from "./blocks";
import { defaultTargetFor, detectLanguage, type LangCode } from "./detection";
import { debounce, type Debounced } from "./debounce";
import { TranslationMemory } from "./tm";
import { type Api, type BatchResult } from "./api";

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
  /** Trailing pause after the last keystroke before a request fires. */
  debounceMs?: number;
  /** Guaranteed maximum wait while the user types continuously. */
  maxWaitMs?: number;
  waveSize?: number;
}

/** One aligned sentence/unit: character range in both panes. */
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

const EMPTY_PANE = (): PaneState => ({
  text: "",
  lang: "auto",
  detected: "auto",
  busy: false,
});

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

interface WaveJob {
  gen: number;
  translator: AbortController;
}

export class SyncController {
  private readonly api: Api;
  private readonly onUpdate: (state: ControllerState) => void;
  private readonly onToast: (toast: ToastMessage) => void;
  private readonly waveSize: number;

  private readonly debounced: Debounced;
  private readonly tm = new TranslationMemory();

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

  /** Side whose text is the source of the currently aligned pair. */
  private mappingSide: Side | null = null;
  private generation = 0;
  private wave: WaveJob | null = null;
  private toastSeq = 0;
  private startedAt = 0;

  constructor(opts: ControllerOptions) {
    this.api = opts.api;
    this.onUpdate = opts.onUpdate;
    this.onToast = opts.onToast;
    this.waveSize = Math.min(Math.max(opts.waveSize ?? 12, 1), 64);
    // 800 ms after the last keystroke, at most every 2.6 s while typing
    // continuously — long enough to batch a whole sentence.
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
    this.mappingSide = null;
    const active = this.state.active;
    if (active) this.runNow();
  }

  swap(): void {
    const s = this.state;
    this.mappingSide = null;
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
    this.cancelInflight();
    this.debounced.cancel();
    this.generation++;
    this.mappingSide = null;
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

  /** Full re-sync of the current source pane (forces fresh server work). */
  retranslateAll(): void {
    const active = this.state.active;
    if (!active) return;
    this.mappingSide = null;
    void this.run(true);
  }

  /** Load a previously persisted session without triggering translation. */
  restore(left: PaneState, right: PaneState): void {
    this.setState((s) => ({ ...s, left, right, active: null }));
    this.mappingSide = null;
  }

  dispose(): void {
    this.debounced.cancel();
    this.cancelInflight();
  }

  /**
   * Exact sentence alignment of the currently displayed pair, or null when
   * the target pane is not byte-identical to what memory can compose (e.g.
   * mid-flight partial output, or the target was hand-edited). The UI falls
   * back to proportional paragraph mapping in that case.
   */
  alignFor(selectedSide: Side): Alignment | null {
    const srcSide = this.mappingSide;
    if (!srcSide) return null;
    const src = this.state[srcSide];
    const dstSide = opposite(srcSide);
    const dst = this.state[dstSide];
    if (!src.text.trim() || !dst.text) return null;
    // Only meaningful when the user interacts with one of the aligned panes.
    if (selectedSide !== srcSide && selectedSide !== dstSide) return null;

    const pair = computePair(src, dst, src.text);
    if (pair.to === "auto") return null;

    const blocks = splitBlocks(src.text);
    const rows: AlignRow[] = [];
    const assembled: string[] = [];
    const spans = mapBlocks(src.text);
    let cursor = 0;
    let delta = 0; // target length - source length accumulated above blocks
    for (let bi = 0; bi < spans.length; bi++) {
      const [bStart, bEnd] = spans[bi];
      const content = blocks[bi];
      assembled.push(src.text.slice(cursor, bStart));
      const units = splitRequestUnits(content);
      const translations: string[] = [];
      let resolved = true;
      for (const unit of units) {
        const t = this.tm.get(pair.from, pair.to, unit.text);
        if (t === undefined) {
          resolved = false;
          break;
        }
        translations.push(t);
      }
      if (!resolved) return null;
      const composed = composeUnits(units, translations, true);
      assembled.push(composed.text.replace(/\r?\n/g, " "));

      // Local src offsets (unit text + following ws keep rows contiguous).
      let srcLocal = 0;
      for (let ui = 0; ui < units.length; ui++) {
        const srcS = bStart + srcLocal;
        const srcE = srcS + units[ui].text.length + units[ui].ws.length;
        const dstS = bStart + delta + (composed.units[ui]?.start ?? 0);
        const dstE =
          bStart +
          delta +
          (ui + 1 < composed.units.length
            ? composed.units[ui + 1].start
            : composed.text.length);
        rows.push({ srcS, srcE, dstS, dstE });
        srcLocal = srcE - bStart;
      }
      delta += composed.text.length - content.length;
      cursor = bEnd;
    }
    assembled.push(src.text.slice(cursor));
    if (assembled.join("") !== dst.text) return null; // pane drifted
    return { srcSide, rows };
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

  /** Synchronise the current source pane → target pane. */
  private async run(force = false): Promise<void> {
    const active = this.state.active;
    if (!active) return;
    // Any still-running chain belongs to an older keystroke: cancel it and
    // invalidate its generation so it can never apply or toast stale results.
    this.cancelInflight();
    this.generation++;
    const src = this.state[active];
    const dst = opposite(active);
    const target = this.state[dst];
    const srcText = src.text;

    // Nothing to translate when both panes already hold identical text.
    if (srcText.length > 0 && target.text === srcText) {
      this.clearBusy();
      return;
    }

    if (srcText.trim().length === 0) {
      if (target.text.length > 0) this.applyTo(dst, "");
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
      return; // cannot translate into "auto"
    }

    const blocks = splitBlocks(srcText);

    // Collect the bounded units that still lack a translation — the ONLY
    // things ever sent to the server. Identical units collapse into one.
    const missingTexts: string[] = [];
    const seen = new Set<string>();
    for (const content of blocks) {
      for (const unit of splitRequestUnits(content)) {
        const cached = !force && this.tm.get(pair.from, pair.to, unit.text);
        if (cached === undefined && !seen.has(unit.text)) {
          seen.add(unit.text);
          missingTexts.push(unit.text);
        }
      }
    }

    // Fast path: memory already covers every unit.
    if (missingTexts.length === 0) {
      const out = this.assembleDoc(srcText, blocks, pair, null);
      this.applyTo(dst, out.text);
      if (out.unresolved === 0) this.mappingSide = active;
      this.setState((s) => ({
        ...s,
        phase: "idle",
        statusText: "已从记忆恢复",
        progress: null,
        left: { ...s.left, busy: false },
        right: { ...s.right, busy: false },
      }));
      return;
    }

    await this.runSegmentWaves({
      active,
      dst,
      srcText,
      blocks,
      pair,
      missingTexts,
      force,
    });
  }

  /**
   * Rebuild the target document: for every source block splice the known unit
   * translations; blocks with unknown units fall back to the previously
   * displayed target block (or the source text when no target exists yet).
   */
  private assembleDoc(
    srcText: string,
    blocks: string[],
    pair: Pair,
    fallbackTarget: string | null
  ): { text: string; unresolved: number } {
    const fbBlocks = fallbackTarget !== null ? splitBlocks(fallbackTarget) : null;
    let unresolved = 0;
    const text = rebuildWithResolver(srcText, (blockIdx, content) => {
      const units = splitRequestUnits(content);
      const translations: string[] = [];
      for (const unit of units) {
        const cached = this.tm.get(pair.from, pair.to, unit.text);
        if (cached === undefined) {
          translations.length = 0;
          break;
        }
        translations.push(cached);
      }
      if (translations.length === units.length) {
        return composeUnits(units, translations, true).text.replace(/\r?\n/g, " ");
      }
      unresolved++;
      const fallback =
        fbBlocks !== null && blockIdx < fbBlocks.length ? fbBlocks[blockIdx] : null;
      return fallback ?? blocks[blockIdx];
    });
    return { text, unresolved };
  }

  private async runSegmentWaves(args: {
    active: Side;
    dst: Side;
    srcText: string;
    blocks: string[];
    pair: Pair;
    missingTexts: string[];
    force: boolean;
  }): Promise<void> {
    const { active, dst, srcText, blocks, pair, missingTexts, force } = args;
    const gen = ++this.generation;
    this.cancelInflight();

    const controller = new AbortController();
    this.wave = { gen, translator: controller };
    this.startedAt = performance.now();

    const total = missingTexts.length;
    let okCount = 0;
    let failedTexts: string[] = [];
    let errorMessage = "";
    let lastProvider: string | null = null;
    let expectedTarget = this.state[dst].text;

    this.setState((s) => ({
      ...s,
      phase: "translating",
      statusText: total > 1 ? `正在翻译 0/${total} 句` : "正在翻译…",
      progress: { done: 0, total },
      [dst]: { ...s[dst], busy: true },
    }));

    const idFor = (index: number): string => `${gen}:${active}:${index}`;

    /** Translate a list of unit texts; on whole-wave failure retries each
     *  unit individually so a single bad sentence cannot stall everything. */
    const fetchItems = async (
      items: Array<{ id: string; text: string }>
    ): Promise<BatchResult[]> => {
      try {
        return await this.api.translateBatch(
          items.map((it) => ({
            id: it.id,
            text: it.text,
            from: pair.from,
            to: pair.to,
            noCache: force,
          })),
          controller.signal
        );
      } catch (err) {
        if (this.generation !== gen) throw err;
        errorMessage = err instanceof Error ? err.message : String(err);
        // Degrade gracefully: one request at a time.
        const singles: BatchResult[] = [];
        for (const item of items) {
          if (this.generation !== gen) return singles;
          try {
            const res = await this.api.translateBatch(
              [{ id: item.id, text: item.text, from: pair.from, to: pair.to, noCache: force }],
              controller.signal
            );
            singles.push(...res);
          } catch (singleErr) {
            singles.push({
              id: item.id,
              ok: false,
              error: {
                code: "ITEM_FAILED",
                message:
                  singleErr instanceof Error ? singleErr.message : String(singleErr),
              },
            });
          }
        }
        return singles;
      }
    };

    try {
      for (let offset = 0; offset < missingTexts.length; offset += this.waveSize) {
        if (this.generation !== gen) return; // superseded mid-flight
        const slice = missingTexts.slice(offset, offset + this.waveSize);
        const items = slice.map((text, i) => ({ id: idFor(offset + i), text }));

        const results = await fetchItems(items);
        if (this.generation !== gen) return; // aborted while awaiting

        const byId = new Map(results.map((r) => [r.id, r]));
        slice.forEach((text, i) => {
          const r = byId.get(idFor(offset + i));
          if (r && r.ok) {
            this.tm.set(pair.from, pair.to, text, r.translated);
            okCount++;
            lastProvider = lastProvider ?? r.provider;
          } else {
            failedTexts.push(text);
            errorMessage = r && !r.ok ? r.error.message : errorMessage;
          }
        });

        this.setState((s) => ({
          ...s,
          statusText: total > 1 ? `正在翻译 ${okCount}/${total} 句` : "正在翻译…",
          progress: { done: okCount, total },
        }));

        // Progressive fill: splice what we have into the target pane.
        const currentTarget = this.state[dst];
        if (this.state.active === active && currentTarget.text === expectedTarget) {
          const assembled = this.assembleDoc(srcText, blocks, pair, currentTarget.text);
          this.applyTo(dst, assembled.text);
          if (assembled.unresolved === 0) this.mappingSide = active;
          expectedTarget = assembled.text;
        }
      }
    } finally {
      if (this.generation === gen) {
        const elapsed = Math.round(performance.now() - this.startedAt);
        const hasFailure = failedTexts.length > 0;
        this.setState((s) => ({
          ...s,
          phase: "idle",
          progress: null,
          left: { ...s.left, busy: false },
          right: { ...s.right, busy: false },
          provider: hasFailure ? s.provider : lastProvider ?? s.provider,
          statusText: hasFailure
            ? "部分内容翻译失败"
            : total > 1
              ? `已同步 ${okCount} 句`
              : lastProvider
                ? `已由 ${lastProvider} 翻译 · ${elapsed} ms`
                : null,
        }));
        if (hasFailure) {
          this.onToast({
            id: ++this.toastSeq,
            kind: "error",
            message:
              failedTexts.length >= total
                ? errorMessage || "翻译失败，请重试"
                : `有 ${failedTexts.length} 句翻译失败，其余已同步`,
            actionLabel: "重试",
            onAction: () => this.retry(),
          });
        }
        this.wave = null;
      }
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

  private cancelInflight(): void {
    if (this.wave) {
      this.wave.translator.abort();
      this.wave = null;
    }
  }
}
