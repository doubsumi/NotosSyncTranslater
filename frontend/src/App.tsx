import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { ToastHost } from "./components/ToastHost";
import { TranslatePane } from "./components/TranslatePane";
import { Icon } from "./components/Icon";
import {
  type Alignment,
  type AlignRow,
  type Side,
} from "./lib/controller";
import type { TextRange } from "./lib/cm";
import { blockRangeForSelection, mapBlocks } from "./lib/blocks";
import { useSyncTranslate } from "./hooks/useSyncTranslate";

type Role = "source" | "target";

interface RangeState {
  left: TextRange | null;
  right: TextRange | null;
}

const EMPTY_RANGES: RangeState = { left: null, right: null };

/**
 * CodeMirror-based linking:
 *  - each pane is a CodeMirror 6 editor (decorations via .cm-linked/.cm-flash);
 *  - pointer interaction links the caret/selection sentence across panes
 *    (counterpart highlight persists, self sentence flashes briefly);
 *  - scroll stays ratio-linked on the editor scrollDOMs.
 * Exact sentence mapping comes from SyncController.alignFor; when the target
 * pane is not composed output it degrades to proportional paragraph mapping.
 */

export default function App(): JSX.Element {
  const { state, actions, toasts } = useSyncTranslate();

  const viewsRef = useRef<Partial<Record<Side, EditorView>>>({});
  const uiLockUntil = useRef(0);
  const flashVersion = useRef(0);
  const lastCaretKey = useRef("");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [link, setLink] = useState<RangeState>(EMPTY_RANGES);
  const [flash, setFlash] = useState<RangeState>(EMPTY_RANGES);

  const isLocked = useCallback(() => performance.now() < uiLockUntil.current, []);
  const lock = useCallback((ms: number) => {
    uiLockUntil.current = performance.now() + ms;
  }, []);

  // ------------------------------------------------------------------
  // Scroll linking on the editors' scroll DOMs.
  // ------------------------------------------------------------------
  useEffect(() => {
    const left = viewsRef.current.left;
    const right = viewsRef.current.right;
    if (!left || !right) return;

    const linkScroll = (side: Side) => () => {
      if (isLocked()) return;
      const src = viewsRef.current[side];
      const dst = viewsRef.current[side === "left" ? "right" : "left"];
      if (!src || !dst) return;
      const sEl = src.scrollDOM;
      const dEl = dst.scrollDOM;
      const maxSrc = sEl.scrollHeight - sEl.clientHeight;
      if (maxSrc <= 0) return;
      const ratio = sEl.scrollTop / maxSrc;
      const maxDst = dEl.scrollHeight - dEl.clientHeight;
      if (maxDst <= 0) return;
      lock(80);
      dEl.scrollTop = ratio * maxDst;
    };
    const onL = linkScroll("left");
    const onR = linkScroll("right");
    left.scrollDOM.addEventListener("scroll", onL, { passive: true });
    right.scrollDOM.addEventListener("scroll", onR, { passive: true });
    return () => {
      left.scrollDOM.removeEventListener("scroll", onL);
      right.scrollDOM.removeEventListener("scroll", onR);
    };
  }, [isLocked, lock]);

  // ------------------------------------------------------------------
  // Highlights are cleared whenever either pane's text changes, so stale
  // character ranges never linger over edited documents.
  // ------------------------------------------------------------------
  useEffect(() => {
    setLink(EMPTY_RANGES);
    setFlash(EMPTY_RANGES);
  }, [state.left.text, state.right.text]);

  // Clear any pending flash timer on unmount.
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  /** Persist a counterpart highlight and bring it into view. */
  const highlightCounterpart = useCallback(
    (targetSide: Side, range: TextRange) => {
      setLink((s) => ({ ...s, [targetSide]: range }));
      const v = viewsRef.current[targetSide];
      if (v) {
        lock(160);
        v.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: "center" }) });
      }
    },
    [lock]
  );

  /** Briefly flash a sentence on the interacting pane (caret stays put). */
  const flashOwn = useCallback(
    (side: Side, range: TextRange) => {
      const version = ++flashVersion.current;
      setFlash((s) => ({ ...s, [side]: range }));
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        if (flashVersion.current !== version) return;
        setFlash((s) => ({ ...s, [side]: null }));
      }, 280);
    },
    []
  );

  /** Rows intersected by [from, to) in a given coordinate space. */
  const rowRangeFor = useCallback(
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

  /** Proportional paragraph fallback when exact mapping is unavailable. */
  const fallbackRange = useCallback(
    (srcSide: Side, from: number, to: number): TextRange | null => {
      const dstSide: Side = srcSide === "left" ? "right" : "left";
      const srcText = srcSide === "left" ? state.left.text : state.right.text;
      const dstText = dstSide === "left" ? state.left.text : state.right.text;
      const srcBlocks = mapBlocks(srcText);
      const dstBlocks = mapBlocks(dstText);
      if (
        srcBlocks.length === 0 ||
        dstBlocks.length === 0 ||
        srcBlocks.length !== dstBlocks.length
      ) {
        return null;
      }
      const blocks = blockRangeForSelection(srcText, from, to);
      if (!blocks) return null;
      const [lo, hi] = blocks;
      const srcBlockLen = Math.max(1, srcBlocks[lo][1] - srcBlocks[lo][0]);
      const dstBlockLen = Math.max(1, dstBlocks[lo][1] - dstBlocks[lo][0]);
      const innerFrom = Math.max(from - srcBlocks[lo][0], 0);
      const dstFrom =
        dstBlocks[lo][0] + Math.round((innerFrom / srcBlockLen) * dstBlockLen);
      const dstTo =
        hi > lo
          ? dstBlocks[hi][1]
          : Math.min(
              dstFrom + Math.max(1, to - from),
              dstBlocks[lo][1]
            );
      return dstTo > dstFrom
        ? { from: Math.min(dstFrom, dstText.length), to: Math.min(dstTo, dstText.length) }
        : null;
    },
    [state.left.text, state.right.text]
  );

  /**
   * Pointer interaction handler: real selection or caret inside a sentence.
   */
  const handlePointer = useCallback(
    (side: Side) => {
      const v = viewsRef.current[side];
      if (!v || isLocked()) return;
      const sel = v.state.selection.main;
      const from = Math.min(sel.from, sel.to);
      const to = Math.max(sel.from, sel.to);
      if (to > from) {
        // 1) A real selection -> highlight the counterpart sentence(s).
        const alignment: Alignment | null = actions.alignment(side);
        let counterpart: TextRange | null = null;
        if (alignment) {
          const selectedIsSource = side === alignment.srcSide;
          const useDst = selectedIsSource;
          const hit = rowRangeFor(alignment.rows, useDst, from, to);
          if (hit) {
            const rows = alignment.rows;
            counterpart = useDst
              ? { from: rows[hit[0]].dstS, to: rows[hit[1]].dstE }
              : { from: rows[hit[0]].srcS, to: rows[hit[1]].srcE };
          }
        }
        if (!counterpart) counterpart = fallbackRange(side, from, to);
        if (counterpart) {
          highlightCounterpart(side === "left" ? "right" : "left", counterpart);
        }
        return;
      }

      // 2) Collapsed caret inside text -> link that sentence both ways.
      const doc = v.state.doc.toString();
      if (!doc || from >= doc.length) return;
      const alignment: Alignment | null = actions.alignment(side);
      if (!alignment) return;
      const selectedIsSource = side === alignment.srcSide;
      const useDst = !selectedIsSource;
      const caretRow = alignment.rows.find((r) => {
        const s = useDst ? r.dstS : r.srcS;
        const e = useDst ? r.dstE : r.srcE;
        return from >= s && from < e;
      });
      if (!caretRow) return;
      const key = `${side}:${caretRow.srcS}`;
      if (key === lastCaretKey.current) return; // no churn
      lastCaretKey.current = key;

      const counterpart: TextRange = selectedIsSource
        ? { from: caretRow.dstS, to: caretRow.dstE }
        : { from: caretRow.srcS, to: caretRow.srcE };
      highlightCounterpart(side === "left" ? "right" : "left", counterpart);
      const own: TextRange = selectedIsSource
        ? { from: caretRow.srcS, to: caretRow.srcE }
        : { from: caretRow.dstS, to: caretRow.dstE };
      flashOwn(side, own);
    },
    [actions, fallbackRange, flashOwn, highlightCounterpart, isLocked, rowRangeFor]
  );

  // ------------------------------------------------------------------
  const registerView = useCallback(
    (side: Side) => (editor: EditorView | null) => {
      if (editor) viewsRef.current[side] = editor;
      else delete viewsRef.current[side];
    },
    []
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
            link={link.left}
            flash={flash.left}
            onViewReady={registerView("left")}
            onPointer={() => handlePointer("left")}
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
            link={link.right}
            flash={flash.right}
            onViewReady={registerView("right")}
            onPointer={() => handlePointer("right")}
            onEdit={(text) => actions.edit("right", text)}
            onChangeLang={(lang) => actions.changeLang("right", lang)}
            onToast={(kind, message) => actions.toast(kind, message)}
            onClear={() => actions.edit("right", "")}
          />
        </div>

        <footer className="app-footer">
          <p>
            使用免费公共翻译引擎（Bing / Alibaba / Sogou 自动切换），文本仅用于翻译请求；不设长度上限，
            长文按句切分、只增量请求被修改的句子。编辑器内核：CodeMirror 6 · MIT License。
          </p>
        </footer>
      </main>
    </div>
  );
}
