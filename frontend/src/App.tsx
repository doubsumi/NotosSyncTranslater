import { useCallback, useEffect, useRef } from "react";
import { ToastHost } from "./components/ToastHost";
import { TranslatePane } from "./components/TranslatePane";
import { Icon } from "./components/Icon";
import { blockRangeForSelection, mapBlocks, textProgress } from "./lib/blocks";
import { type Side } from "./lib/controller";
import { useSyncTranslate } from "./hooks/useSyncTranslate";

type Role = "source" | "target";

export default function App(): JSX.Element {
  const { state, actions, toasts } = useSyncTranslate();

  // ------------------------------------------------------------------
  // Scroll + selection linking between the two textareas.
  // ------------------------------------------------------------------
  const leftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const rightInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Timestamp lock: programmatic scroll/selection must not echo back.
  const uiLockUntil = useRef(0);
  const isLocked = useCallback(() => performance.now() < uiLockUntil.current, []);
  const lock = useCallback((ms: number) => {
    uiLockUntil.current = performance.now() + ms;
  }, []);

  // 1) Scrolling one pane mirrors the other (ratio-based; both documents
  //    share the same line layout because translations never add newlines).
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
  }, [isLocked, lock]);

  // 2) Selecting text in one pane highlights the corresponding region in the
  //    other. Both panes share block-aligned layout; inside a block the
  //    mapping is proportional (sentence lengths differ across languages).
  const syncSelectionFrom = useCallback(
    (side: Side) => {
      if (isLocked()) return;
      const src = side === "left" ? leftInputRef.current : rightInputRef.current;
      const dst = side === "left" ? rightInputRef.current : leftInputRef.current;
      if (!src || !dst || src.value.length === 0) return;
      const selStart = src.selectionStart ?? 0;
      const selEnd = src.selectionEnd ?? 0;
      if (selEnd <= selStart) return;

      const srcBlocks = mapBlocks(src.value);
      const dstBlocks = mapBlocks(dst.value);
      if (srcBlocks.length === 0 || dstBlocks.length === 0) return;
      if (srcBlocks.length !== dstBlocks.length) return; // layout diverged

      const range = blockRangeForSelection(src.value, selStart, selEnd);
      if (!range) return;
      const [lo, hi] = range;

      const [srcBlockStart, srcBlockEnd] = srcBlocks[lo];
      const [dstBlockStart, dstBlockEnd] = dstBlocks[lo];
      const [, dstBlockLastEnd] = dstBlocks[hi];

      // Proportional mapping inside the first selected block …
      const inBlockStart = Math.max(selStart, srcBlockStart);
      const srcSpan = Math.max(1, srcBlockEnd - srcBlockStart);
      const dstSpanStart = Math.max(1, dstBlockEnd - dstBlockStart);
      let toStart = Math.round(
        dstBlockStart + ((inBlockStart - srcBlockStart) / srcSpan) * dstSpanStart
      );
      let toEnd =
        hi > lo
          ? dstBlockLastEnd
          : Math.round(
              dstBlockStart +
                ((selEnd - srcBlockStart) / srcSpan) * dstSpanStart
            );
      toStart = Math.min(Math.max(toStart, dstBlockStart), dstBlockEnd);
      toEnd = Math.min(Math.max(toEnd, toStart), dstBlockEnd);

      if (toEnd <= toStart) return;
      lock(120);
      dst.setSelectionRange(toStart, toEnd);

      // Bring the highlighted region into view on the partner pane.
      const fraction = textProgress(dst.value, toStart);
      const maxScroll = dst.scrollHeight - dst.clientHeight;
      if (maxScroll > 0) {
        dst.scrollTop = Math.max(0, Math.min(maxScroll, fraction * maxScroll));
      }
    },
    [isLocked, lock]
  );

  const handleUserSelection = useCallback(
    (side: Side) => () => syncSelectionFrom(side),
    [syncSelectionFrom]
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
            onUserSelection={handleUserSelection("left")}
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
            onUserSelection={handleUserSelection("right")}
            onEdit={(text) => actions.edit("right", text)}
            onChangeLang={(lang) => actions.changeLang("right", lang)}
            onToast={(kind, message) => actions.toast(kind, message)}
            onClear={() => actions.edit("right", "")}
          />
        </div>

        <footer className="app-footer">
          <p>
            使用免费公共翻译引擎（Bing / Alibaba / Sogou 自动切换），文本仅用于翻译请求；不设长度上限，
            长文按句切分、只增量请求被修改的句子；两侧滚动与选区同步。项目开源于 MIT License。
          </p>
        </footer>
      </main>
    </div>
  );
}
