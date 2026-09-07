// ---------------------------------------------------------------------------
// SyncController — the brain of the two-way live translator.
//
// Guarantees implemented here (and unit-tested):
//   1. Two-way editing: whatever pane the user types in becomes the source,
//      the other pane follows.
//   2. Debounce (trailing pause + max-wait) with abort of stale work: at most
//      one request chain runs per burst; older results never clobber newer.
//   3. Sentence-level translation memory (TM): requests are scoped to the
//      *sentence* the user changed — unchanged sentences and paragraphs are
//      spliced from memory with zero network traffic (edit-here / update-here).
//   4. Whole documents are processed in bounded waves (no input length cap),
//      progressively filling the target pane with progress feedback.
//   5. Results never overwrite text the user is actively editing; partial
//      failures surface as retryable toasts, never as inline errors.
// ---------------------------------------------------------------------------

import {
  joinSentenceParts,
  rebuildWithResolver,
  splitBlocks,
  splitSentences,
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
  /** Human status, e.g. "已由 bing 翻译 · 412 ms" or "正在翻译 3/12 段". */
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
    // continuously — long enough to batch a whole sentence, short enough to
    // feel live.
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
    const active = this.state.active;
    if (active) this.runNow();
  }

  swap(): void {
    const s = this.state;
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
    void this.run(true);
  }

  /** Load a previously persisted session without triggering translation. */
  restore(left: PaneState, right: PaneState): void {
    this.setState((s) => ({ ...s, left, right, active: null }));
  }

  dispose(): void {
    this.debounced.cancel();
    this.cancelInflight();
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

    // Collect the sentence parts that still lack a translation (the ONLY
    // things we ever send to the server). Identical sentences anywhere in the
    // document collapse into one request.
    const missingTexts: string[] = [];
    const seen = new Set<string>();
    for (const content of blocks) {
      for (const part of splitSentences(content)) {
        const cached = !force && this.tm.get(pair.from, pair.to, part.text);
        if (cached === undefined && !seen.has(part.text)) {
          seen.add(part.text);
          missingTexts.push(part.text);
        }
      }
    }

    // Fast path: translation memory already covers every sentence.
    if (missingTexts.length === 0) {
      const out = this.assembleDoc(srcText, blocks, pair, null);
      this.applyTo(dst, out.text);
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
   * Rebuild the target document: for every source block, splice the sentence
   * translations that are known; blocks with unknown sentences fall back to
   * the currently displayed target block (or to the source text when there is
   * no previous target yet).
   */
  private assembleDoc(
    srcText: string,
    blocks: string[],
    pair: Pair,
    fallbackTarget: string | null
  ): { text: string; unresolved: number } {
    const fbBlocks = fallbackTarget !== null ? splitBlocks(fallbackTarget) : null;
    let unresolved = 0;
    const resolved = rebuildWithResolver(srcText, (blockIdx, content) => {
      const parts = splitSentences(content);
      const translations: string[] = [];
      for (const part of parts) {
        const cached = this.tm.get(pair.from, pair.to, part.text);
        if (cached === undefined) {
          translations.length = 0;
          break;
        }
        translations.push(cached);
      }
      if (translations.length === parts.length) {
        // Smart spacing: avoid stray spaces between CJK segments.
        return joinSentenceParts(parts, translations, true).replace(/\r?\n/g, " ");
      }
      unresolved++;
      const fallback =
        fbBlocks !== null && blockIdx < fbBlocks.length ? fbBlocks[blockIdx] : null;
      return fallback ?? blocks[blockIdx];
    });
    return { text: resolved, unresolved };
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

    try {
      for (let offset = 0; offset < missingTexts.length; offset += this.waveSize) {
        if (this.generation !== gen) return; // superseded mid-flight
        const slice = missingTexts.slice(offset, offset + this.waveSize);
        const items = slice.map((text, i) => ({
          id: idFor(offset + i),
          text,
          from: pair.from,
          to: pair.to,
          noCache: force,
        }));

        let results: BatchResult[];
        try {
          results = await this.api.translateBatch(items, controller.signal);
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err);
          failedTexts = failedTexts.concat(slice);
          if (this.generation !== gen) return;
          break;
        }
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
          statusText:
            total > 1 ? `正在翻译 ${okCount}/${total} 句` : "正在翻译…",
          progress: { done: okCount, total },
        }));

        // Progressive fill: splice what we have into the target pane.
        const currentTarget = this.state[dst];
        if (this.state.active === active && currentTarget.text === expectedTarget) {
          const assembled = this.assembleDoc(srcText, blocks, pair, currentTarget.text);
          this.applyTo(dst, assembled.text);
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
