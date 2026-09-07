import { useMemo, useState } from "react";
import { computePair, type PaneState, type ProgressState } from "../lib/controller";
import { detectLanguage, langLabel, type LangCode } from "../lib/detection";
import { Icon } from "./Icon";
import { LanguageSelect } from "./LanguageSelect";

interface Props {
  pane: PaneState;
  other: PaneState;
  role: "source" | "target";
  progress: ProgressState | null;
  onEdit: (text: string) => void;
  onChangeLang: (lang: LangCode) => void;
  onToast: (kind: "success" | "error" | "info", message: string) => void;
  onClear: () => void;
}

/** Copy with graceful fallback for older browsers / permissions. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

export function TranslatePane({
  pane,
  other,
  role,
  progress,
  onEdit,
  onChangeLang,
  onToast,
  onClear,
}: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const pair = useMemo(
    () => computePair(role === "source" ? pane : other, role === "source" ? other : pane),
    [pane, other, role]
  );
  const detected =
    pane.lang === "auto" && pane.text.trim().length > 0
      ? detectLanguage(pane.text).code
      : "auto";
  const chars = pane.text.length;
  const lines = useMemo(() => {
    if (chars === 0) return 0;
    let n = 0;
    for (let i = 0; i < pane.text.length; i++) if (pane.text.charCodeAt(i) === 10) n++;
    return n + 1;
  }, [pane.text, chars]);

  const handleCopy = async (): Promise<void> => {
    if (!pane.text) {
      onToast("info", role === "source" ? "没有可复制的原文" : "还没有译文可复制");
      return;
    }
    const ok = await copyText(pane.text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      onToast("success", "已复制到剪贴板");
    } else {
      onToast("error", "复制失败，请手动选择文本复制");
    }
  };

  const busy = pane.busy;
  const placeholder =
    role === "source"
      ? "在此输入或粘贴要翻译的内容…（自动识别语言）"
      : pane.text.length > 0
        ? ""
        : "译文将实时显示在这里…";

  return (
    <section
      className={`pane pane-${role}${busy ? " is-busy" : ""}`}
      aria-label={role === "source" ? "源语言输入框" : "译文输出框"}
    >
      <header className="pane-header">
        <div className="pane-title-row">
          <span className={`role-badge role-${role}`}>
            {role === "source" ? "原文" : "译文"}
          </span>
          <LanguageSelect
            value={pane.lang}
            onChange={onChangeLang}
            ariaLabel={role === "source" ? "源语言" : "目标语言"}
          />
          {role === "source" && pane.lang === "auto" && detected !== "auto" && (
            <span className="detect-chip" title="已自动识别到的语言">
              已检测：{langLabel(detected)}
            </span>
          )}
          {role === "source" &&
            pane.lang === "auto" &&
            detected === "auto" &&
            pane.text.trim().length > 0 && (
              <span className="detect-chip subtle">正在识别…</span>
            )}
        </div>
        {role === "target" && (
          <div className="pane-hint">
            {pane.lang === "auto"
              ? `将译成：${pair.to !== "auto" ? langLabel(pair.to) : "自动"}`
              : `目标语言：${langLabel(pane.lang)}`}
          </div>
        )}
        {role === "source" && (
          <div className="pane-hint">
            {pair.to !== "auto" ? `原文 → ${langLabel(pair.to)}` : "请先输入内容"}
          </div>
        )}
      </header>

      <div className="pane-body">
        <textarea
          className="pane-input"
          value={pane.text}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={role === "source" ? "源文本编辑区" : "译文编辑区"}
        />
        {role === "target" && busy && (
          <div className="busy-overlay" aria-hidden="true">
            <span className="spinner" />
            {progress && progress.total > 1
              ? `正在翻译 ${progress.done}/${progress.total} 段`
              : "正在翻译…"}
          </div>
        )}
      </div>

      <footer className="pane-footer">
        <div className="pane-stats">
          <span>{chars.toLocaleString()} 字符</span>
          <span className="sep">·</span>
          <span>{lines.toLocaleString()} 行</span>
        </div>
        <div className="pane-tools">
          <button
            type="button"
            className="tool-btn"
            onClick={handleCopy}
            title="复制内容"
            aria-label="复制内容"
          >
            <Icon name={copied ? "pencil" : "copy"} size={15} />
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
          <button
            type="button"
            className="tool-btn danger"
            onClick={onClear}
            title="清空这一侧（另一侧会同步清空）"
            aria-label="清空这一侧"
          >
            <Icon name="trash" size={15} />
            <span>清空</span>
          </button>
        </div>
      </footer>
    </section>
  );
}
