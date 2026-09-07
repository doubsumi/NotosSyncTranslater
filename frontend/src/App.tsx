import { ToastHost } from "./components/ToastHost";
import { TranslatePane } from "./components/TranslatePane";
import { Icon } from "./components/Icon";
import { type Side } from "./lib/controller";
import { useSyncTranslate } from "./hooks/useSyncTranslate";

type Role = "source" | "target";

export default function App(): JSX.Element {
  const { state, actions, toasts } = useSyncTranslate();

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
                  ? `正在翻译 ${state.progress.done}/${state.progress.total} 段`
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
            other={state.right}
            role={roleFor("left")}
            progress={state.progress}
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
            other={state.left}
            role={roleFor("right")}
            progress={state.progress}
            onEdit={(text) => actions.edit("right", text)}
            onChangeLang={(lang) => actions.changeLang("right", lang)}
            onToast={(kind, message) => actions.toast(kind, message)}
            onClear={() => actions.edit("right", "")}
          />
        </div>

        <footer className="app-footer">
          <p>
            使用免费公共翻译引擎（Bing / Alibaba / Sogou 自动切换），文本仅用于翻译请求；不设长度上限，长文按句分块、
            翻译记忆只增量请求。项目开源于 MIT License。
          </p>
        </footer>
      </main>
    </div>
  );
}
