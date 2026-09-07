import { useCallback, useEffect, useRef } from "react";
import { ToastHost } from "./components/ToastHost";
import { TranslatePane } from "./components/TranslatePane";
import { Icon } from "./components/Icon";
import { type AlignRow, type Side } from "./lib/controller";
import { blockRangeForSelection, mapBlocks, textProgress } from "./lib/blocks";
import { useSyncTranslate } from "./hooks/useSyncTranslate";

type Role = "source" | "target";

/**
 * Cross-pane linking.
 *
 * Two independent mechanisms:
 *  1. exact sentence/unit mapping when the target pane is byte-identical to
 *     what the translation memory composes (controller.alignFor), and
 *  2. a proportional paragraph fallback whenever it is not.
 * A 120 ms lock prevents programmatic selection/scroll from echoing back.
 */

export default function App(): JSX.Element {
  const { state, actions, toasts } = useSyncTranslate();

  const leftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const rightInputRef = useRef<HTMLTextAreaElement | null>(null);
  const uiLockUntil = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashVersion = useRef(0);
  const lastCaretKey = useRef("");

  const isLocked = useCallback(() => performance.now() < uiLockUntil.current, []);
  const lock = useCallback((ms: number) => {
    uiLockUntil.current = performance.now() + ms;
  }, []);

  const ta = useCallback(
    (side: Side): HTMLTextAreaElement | null =>
      side === "left" ? leftInputRef.current : rightInputRef.current,
    []
  );

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  // ------------------------------------------------------------------
  // Scroll linking
  // ------------------------------------------------------------------
  useEffect(() => {
    const left = leftInputRef.current;
    const right = rightInputRef.current;
    if (!left || !right) return;

    const onScroll = (side: Side) => () => {
      if (isLocked()) return;
      const src = side === "left" ? left : right;
      const dst = side === "left" ? right : left;
      const maxSrc = src.scrollHeight - src.clientHeight;
      const ratio = maxSrc > 0 ? src.scrollTop / maxSrc : 0;
      const maxDst = dst.scrollHeight - dst.clientHeight;
      if (maxDst <= 0) return;
      lock(80);
      dst.scrollTop = ratio * maxDst;
    };
    const onL = onScroll("left");
    const onR = onScroll("right");
    left.addEventListener("scroll", onL, { passive: true });
    right.addEventListener("scroll", onR, { passive: true });
    return () => {
      left.removeEventListener("scroll", onL);
      right.removeEventListener("scroll", onR);
    };
  }, [isLocked, lock, ta]);

  /** Select a range inside a textarea and scroll it into view. */
  const selectIn = useCallback(
    (el: HTMLTextAreaElement, from: number, to: number) => {
      if (to <= from) return;
      const len = el.value.length;
      const a = Math.max(0, Math.min(from, len));
      const b = Math.max(a, Math.min(to, len));
      lock(140);
      el.setSelectionRange(a, b);
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll > 0) {
        el.scrollTop = Math.max(
          0,
          Math.min(maxScroll, textProgress(el.value, a) * maxScroll)
        );
      }
    },
    [lock]
  );

  /** Find the unit rows intersected by [from,to) in the given coordinate. */
  const rowIndexRange = useCallback(
    (rows: readonly AlignRow[], useDst: boolean, from: number, to: number) => {
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < rows.length; i++) {
        const s = useDst ? rows[i].dstS : rows[i].srcS;
        const e = useDst ? rows[i].dstE : rows[i].srcE;
        if (e <= from || s >= to) continue;
        if (lo === -1) lo = i;
        hi = i;
      }
      return lo === -1 ? null : ([lo, hi] as const);
    },
    []
  );

  /** Proportional paragraph-level fallback (previous behaviour). */
  const fallbackLink = useCallback(
    (side: Side, from: number, to: number) => {
      const src = ta(side);
      const dst = ta(side === "left" ? "right" : "left");
      if (!src || !dst) return;
      const srcBlocks = mapBlocks(src.value);
      const dstBlocks = mapBlocks(dst.value);
      if (
        srcBlocks.length === 0 ||
        dstBlocks.length === 0 ||
        srcBlocks.length !== dstBlocks.length
      ) {
        return;
      }
      const range = blockRangeForSelection(src.value, from, to);
      if (!range) return;
      const [lo, hi] = range;
      const [, srcEnd] = srcBlocks[lo];
      const [dstStart, dstEnd] = dstBlocks[lo];
      const [, dstLastEnd] = dstBlocks[hi];
      const dstFrom =
        dstStart +
        Math.round(
          ((Math.max(from, srcBlocks[lo][0]) - srcBlocks[lo][0]) /
            Math.max(1, srcEnd - srcBlocks[lo][0])) *
            Math.max(1, dstEnd - dstStart)
        );
      const dstTo = hi > lo ? dstLastEnd : dstFrom + Math.max(1, to - from);
      selectIn(dst, dstFrom, Math.min(dstTo, dstLastEnd));
    },
    [selectIn, ta]
  );

  /** Mirror a source selection/caret to the aligned target range. */
  const linkFrom = useCallback(
    (side: Side, from: number, to: number) => {
      const src = ta(side);
      const other = ta(side === "left" ? "right" : "left");
      if (!src || !other) return;
      if (isLocked()) return;
      const alignment = actions.alignment(side);
      if (!alignment) {
        fallbackLink(side, from, to);
        return;
      }
      const selectedIsSource = side === alignment.srcSide;
      const useDst = selectedIsSource;
      const range = rowIndexRange(alignment.rows, useDst, from, to);
      if (!range) {
        fallbackLink(side, from, to);
        return;
      }
      const [lo, hi] = range;
      const rows = alignment.rows;
      const targetFrom = useDst ? rows[lo].dstS : rows[lo].srcS;
      const targetTo = useDst ? rows[hi].dstE : rows[hi].srcE;
      selectIn(other, targetFrom, targetTo);
    },
    [actions, fallbackLink, isLocked, rowIndexRange, selectIn, ta]
  );

  /**
   * Pointer interaction: with a real selection we mirror it; with a caret in
   * the middle of text we highlight that sentence on the other side and flash
   * it briefly on the active side too (without disturbing the caret).
   */
  const handlePointer = useCallback(
    (side: Side) => {
      const el = ta(side);
      if (!el) return;
      const from = el.selectionStart ?? 0;
      const to = el.selectionEnd ?? 0;
      if (from !== to) {
        flashVersion.current++;
        linkFrom(side, from, to);
        return;
      }
      const text = el.value;
      if (!text || from <= 0 || from >= text.length) return;

      const alignment = actions.alignment(side);
      if (!alignment) return;
      const selectedIsSource = side === alignment.srcSide;
      const rows = alignment.rows;
      const useDst = !selectedIsSource;
      const caretRow = rows.find((r) => {
        const s = useDst ? r.dstS : r.srcS;
        const e = useDst ? r.dstE : r.srcE;
        return from >= s && from < e;
      });
      if (!caretRow) return;

      const key = `${side}:${caretRow.srcS}:${caretRow.srcE}`;
      if (key === lastCaretKey.current) return; // no churn on repeat clicks
      lastCaretKey.current = key;

      const other = ta(side === "left" ? "right" : "left");
      if (other) {
        const otherFrom = selectedIsSource ? caretRow.dstS : caretRow.srcS;
        const otherTo = selectedIsSource ? caretRow.dstE : caretRow.srcE;
        selectIn(other, otherFrom, otherTo);
      }

      // Flash the active side's sentence while keeping the caret position.
      const ownFrom = selectedIsSource ? caretRow.srcS : caretRow.dstS;
      const ownTo = selectedIsSource ? caretRow.srcE : caretRow.dstE;
      const version = ++flashVersion.current;
      const caret = from;
      lock(120);
      el.setSelectionRange(ownFrom, ownTo);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        if (flashVersion.current !== version) return; // stale flash
        if (el.value === text) {
          lock(80);
          el.setSelectionRange(caret, caret);
        }
        lastCaretKey.current = "";
      }, 260);
    },
    [actions, linkFrom, lock, selectIn, ta]
  );

  const roleFor = (side: Side): Role =>
    state.active === null
      ? side === "left"
        ? "source"
        : "target"
      : side === state.active
        ? "source"
        : "target";

  const hasContent = state.left.text.length > 0 || state.right.text.length > 0;
  const busy = state.phase === "translating";
  const otherOf = (side: Side) => (side === "left" ? state.right : state.left);

  return (
    <div className="app">
      <ToastHost toasts={toasts} onDismiss={actions.dismissToast} />

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⇄
          </span>
          <div className="brand-text">
            <h1>Notos 同步翻译</h1>
            <p>修改任意一侧，另一侧实时同步 · Sync Translate</p>
          </div>
        </div>

        <div className="header-tools">
          <div className="status-pill" role="status" aria-live="polite">
            {busy && <span className="spinner spinner-sm" aria-hidden="true" />}
            <span className="status-text">
              {busy
                ? state.progress && state.progress.total > 1
                  ? `正在翻译 ${state.progress.done}/${state.progress.total} 句`
                  : "正在翻译…"
                : state.statusText ?? "就绪"}
            </span>
          </div>

          <button
            type="button"
            className="tool-btn"
            onClick={actions.swap}
            disabled={!hasContent}
            title="交换两侧的语言与内容"
          >
            <Icon name="swap" size={16} />
            <span>交换</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={actions.retranslate}
            disabled={!hasContent || busy}
            title="忽略缓存，重新翻译当前源文本"
          >
            <Icon name="wand" size={16} />
            <span>重译全文</span>
          </button>
          <button
            type="button"
            className="tool-btn danger"
            onClick={actions.clear}
            disabled={!hasContent}
            title="清空全部内容"
          >
            <Icon name="trash" size={16} />
            <span>清空</span>
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="panes">
          <TranslatePane
            pane={state.left}
            other={otherOf("left")}
            role={roleFor("left")}
            progress={state.progress}
            inputRef={leftInputRef}
            onUserSelection={() => handlePointer("left")}
            onEdit={(text) => actions.edit("left", text)}
            onChangeLang={(lang) => actions.changeLang("left", lang)}
            onToast={(kind, message) => actions.toast(kind, message)}
            onClear={() => actions.edit("left", "")}
          />

          <div className="mid-bar" aria-hidden="true">
            <span className="mid-arrow">⇄</span>
          </div>

          <TranslatePane
            pane={state.right}
            other={otherOf("right")}
            role={roleFor("right")}
            progress={state.progress}
            inputRef={rightInputRef}
            onUserSelection={() => handlePointer("right")}
            onEdit={(text) => actions.edit("right", text)}
            onChangeLang={(lang) => actions.changeLang("right", lang)}
            onToast={(kind, message) => actions.toast(kind, message)}
            onClear={() => actions.edit("right", "")}
          />
        </div>

        <footer className="app-footer">
          <p>
            使用免费公共翻译引擎（Bing / Alibaba / Sogou 自动切换），文本仅用于翻译请求；不设长度上限，
            长文按句切分、只增量请求被修改的句子；两侧滚动与选区/光标句子联动。项目开源于 MIT License。
          </p>
        </footer>
      </main>
    </div>
  );
}
