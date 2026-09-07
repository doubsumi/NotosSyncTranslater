// ---------------------------------------------------------------------------
// SyncController — the brain of the two-way live translator.
//
// Guarantees implemented here (and unit-tested):
//   1. Two-way editing: whatever pane the user types in becomes the source,
//      the other pane follows.
//   2. Debounce with max-wait (commercial typing behaviour) + abort of stale
//      in-flight work: at most one request chain runs per burst and older
//      results never clobber newer ones.
//   3. Translation memory (TM): only blocks with no cached translation are
//      ever sent to the server; unchanged/undone blocks resolve instantly.
//   4. Whole documents are handled in bounded waves (no input length cap),
//      progressively filling the target pane with progress feedback.
//   5. Results never overwrite text the user is actively editing; partial
//      failures surface as retryable toasts, never as inline errors.
// ---------------------------------------------------------------------------

import { rebuildWithTranslations, splitBlocks } from "./blocks";
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
  debounceMs?: number;
  maxWaitMs?: number;
  waveSize?: number;
}

interface AppliedRecord {
  srcText: string;
  pair: Pair;
  dstText: string;
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

  private applied: Record<Side, AppliedRecord | null> = {
    left: null,
    right: null,
  };
  private generation = 0;
  private wave: WaveJob | null = null;
  private toastSeq = 0;
  private startedAt = 0;

  constructor(opts: ControllerOptions) {
    this.api = opts.api;
    this.onUpdate = opts.onUpdate;
    this.onToast = opts.onToast;
    this.waveSize = Math.min(Math.max(opts.waveSize ?? 10, 1), 64);
    this.debounced = debounce(opts.debounceMs ?? 420, opts.maxWaitMs ?? 1500);
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
    // The pair may have changed: forget applied translations so the next run
    // re-syncs with the *new* direction.
    this.applied.left = null;
    this.applied.right = null;
    const active = this.state.active;
    if (active) this.runNow();
  }

  swap(): void {
    const s = this.state;
    const nl: PaneState = { ...s.right, text: s.right.text };
    const nr: PaneState = { ...s.left, text: s.left.text };
    this.applied.left = null;
    this.applied.right = null;
    this.setState((st) => ({
      ...st,
      left: nl,
      right: nr,
      active: "left",
      statusText: null,
      progress: null,
    }));
    this.runNow();
  }

  clear(): void {
    this.cancelInflight();
    this.debounced.cancel();
    this.applied.left = null;
    this.applied.right = null;
    this.setState((s) => ({
      ...s,
      left: { ...s.left, text: "", detected: "auto" },
      right: { ...s.right, text: "", detected: "auto" },
      active: null,
      phase: "idle",
      statusText: null,
      progress: null,
      provider: null,
      lastElapsedMs: null,
    }));
  }

  /** Re-translate whatever is still missing (used by error-retry actions). */
  retry(): void {
    const active = this.state.active;
    if (!active) return;
    this.applied[active] = null;
    this.runNow();
  }

  /** Full re-sync of the current source pane (forces fresh server work). */
  retranslateAll(): void {
    const active = this.state.active;
    if (!active) return;
    this.applied.left = null;
    this.applied.right = null;
    void this.run(true);
  }

  /** Load a previously persisted session without triggering translation. */
  restore(left: PaneState, right: PaneState): void {
    this.setState((s) => ({ ...s, left, right, active: null }));
    this.applied.left = null;
    this.applied.right = null;
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

  /** Compute the current source text → target text synchronisation. */
  private async run(force = false): Promise<void> {
    const active = this.state.active;
    if (!active) return;
    const src = this.state[active];
    const dst = opposite(active);
    const target = this.state[dst];
    const srcText = src.text;

    // Nothing to translate when both panes already hold identical text.
    if (srcText.length > 0 && target.text === srcText) return;

    if (srcText.trim().length === 0) {
      if (target.text.length > 0) this.applyTo(dst, "");
      this.applied[active] = null;
      this.setState((s) => ({
        ...s,
        phase: "idle",
        statusText: null,
        progress: null,
      }));
      return;
    }

    const pair = computePair(src, target, srcText);
    if (pair.to === "auto") return; // cannot translate into "auto"

    // Fast path 1: exactly this request was already applied.
    if (!force) {
      const applied = this.applied[active];
      if (
        applied &&
        applied.srcText === srcText &&
        applied.pair.from === pair.from &&
        applied.pair.to === pair.to
      ) {
        if (target.text !== applied.dstText) this.applyTo(dst, applied.dstText);
        return;
      }
    }

    const blocks = splitBlocks(srcText);
    const translations = new Map<number, string>();
    const missing: number[] = [];
    blocks.forEach((b, i) => {
      const cached = !force ? this.tm.get(pair.from, pair.to, b) : undefined;
      if (cached !== undefined) translations.set(i, cached);
      else missing.push(i);
    });

    // Fast path 2: translation memory covers everything (undo/redo, repeats).
    if (!force && missing.length === 0) {
      const dstText = rebuildWithTranslations(srcText, translations);
      this.applyTo(dst, dstText);
      this.applied[active] = { srcText, pair, dstText };
      this.setState((s) => ({
        ...s,
        phase: "idle",
        statusText: "已从记忆恢复",
        progress: null,
      }));
      return;
    }

    await this.translateWaves({
      active,
      dst,
      srcText,
      pair,
      blocks,
      translations,
      missing,
      noCache: force,
    });
  }

  private async translateWaves(args: {
    active: Side;
    dst: Side;
    srcText: string;
    pair: Pair;
    blocks: string[];
    translations: Map<number, string>;
    missing: number[];
    noCache: boolean;
  }): Promise<void> {
    const { active, dst, srcText, pair, blocks, translations, missing, noCache } =
      args;
    const gen = ++this.generation;
    // Supersede any running translation chain.
    this.cancelInflight();

    const controller = new AbortController();
    this.wave = { gen, translator: controller };
    this.startedAt = performance.now();

    const total = missing.length;
    let done = 0;
    let okCount = 0;
    let failedIds: string[] = [];
    let errorMessage = "";
    let lastProvider: string | null = null;
    // What the target pane is expected to contain; only our own writes update
    // it, so any real user edit blocks further overwrites.
    let expectedTarget = this.state[dst].text;

    this.setState((s) => ({
      ...s,
      phase: "translating",
      statusText: total > 1 ? `正在翻译 0/${total} 段` : "正在翻译…",
      progress: { done: 0, total },
      [dst]: { ...s[dst], busy: true },
    }));

    const indexToId = (blockIdx: number): string => `${gen}:${active}:${blockIdx}`;

    try {
      for (let offset = 0; offset < missing.length; offset += this.waveSize) {
        if (this.generation !== gen) return; // superseded mid-flight
        const slice = missing.slice(offset, offset + this.waveSize);
        const items = slice.map((blockIdx) => ({
          id: indexToId(blockIdx),
          text: blocks[blockIdx],
          from: pair.from,
          to: pair.to,
          noCache,
        }));

        let results: BatchResult[];
        try {
          results = await this.api.translateBatch(items, controller.signal);
        } catch (err) {
          // Network/HTTP level failure for the whole wave.
          errorMessage = err instanceof Error ? err.message : String(err);
          failedIds = failedIds.concat(slice.map(indexToId));
          if (this.generation !== gen) return;
          break;
        }
        if (this.generation !== gen) return; // aborted while awaiting

        const byId = new Map(results.map((r) => [r.id, r]));
        for (const blockIdx of slice) {
          const r = byId.get(indexToId(blockIdx));
          if (r && r.ok) {
            translations.set(blockIdx, r.translated);
            this.tm.set(pair.from, pair.to, blocks[blockIdx], r.translated);
            okCount++;
            lastProvider = lastProvider ?? r.provider;
          } else {
            failedIds.push(indexToId(blockIdx));
            errorMessage = r && !r.ok ? r.error.message : errorMessage;
          }
        }
        done = okCount;
        this.setState((s) => ({
          ...s,
          statusText: total > 1 ? `正在翻译 ${done}/${total} 段` : "正在翻译…",
          progress: { done, total },
        }));

        // Progressive fill: splice what we have into the target pane.
        const currentTarget = this.state[dst];
        if (this.state.active === active && currentTarget.text === expectedTarget) {
          const assembled = rebuildWithTranslations(srcText, translations);
          this.applyTo(dst, assembled);
          expectedTarget = assembled;
        }
      }
    } finally {
      if (this.generation === gen) {
        const elapsed = Math.round(performance.now() - this.startedAt);
        const hasFailure = failedIds.length > 0;
        const stillActive = this.state.active === active;
        const ownTarget = this.state[dst].text === expectedTarget;
        this.setState((s) => ({
          ...s,
          phase: "idle",
          progress: null,
          provider: hasFailure ? s.provider : lastProvider ?? s.provider,
          statusText: hasFailure
            ? "部分内容翻译失败"
            : total > 1
              ? `已同步 ${okCount} 段`
              : lastProvider
                ? `已由 ${lastProvider} 翻译 · ${elapsed} ms`
                : null,
        }));
        if (hasFailure) {
          // Keep the partial output visible and let the user retry via the
          // toast (retry re-runs `run()` which only requests blocks that
          // still lack a TM entry).
          this.onToast({
            id: ++this.toastSeq,
            kind: "error",
            message:
              failedIds.length >= total
                ? errorMessage || "翻译失败，请重试"
                : `有 ${failedIds.length} 段翻译失败，其余已同步`,
            actionLabel: "重试",
            onAction: () => this.retry(),
          });
        } else if (stillActive && ownTarget) {
          this.applied[active] = {
            srcText,
            pair,
            dstText: this.state[dst].text,
          };
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
      [dst]: { ...pane, text, busy: false },
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
