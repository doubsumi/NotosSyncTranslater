import { EditorView } from "@codemirror/view";
import { useMemo, useState } from "react";
import { computePair, type PaneState } from "../lib/controller";
import {
  detectLanguage,
  langLabel,
  type LangCode,
} from "../lib/detection";
import type { TextRange } from "../lib/cm";
import { CodePaneInput } from "./CodePaneInput";
import { Icon } from "./Icon";
import { LanguageSelect } from "./LanguageSelect";

interface Props {
  pane: PaneState;
  other: PaneState;
  role: "source" | "target";
  /** Counterpart-sentence highlight (decoration range inside this pane). */
  link: TextRange | null;
  /** Transient self-sentence highlight while the user places a caret. */
  flash: TextRange | null;
  onViewReady: (view: EditorView | null) => void;
  onPointer: () => void;
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
  link,
  flash,
  onViewReady,
  onPointer,
  onEdit,
  onChangeLang,
  onToast,
  onClear,
}: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const pair = useMemo(
    () =>
      computePair(
        role === "source" ? pane : other,
        role === "source" ? other : pane
      ),
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
    for (let i = 0; i < pane.text.length; i++) {
      if (pane.text.charCodeAt(i) === 10) n++;
    }
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

  const placeholderHint =
    role === "source" ? "输入或粘贴要翻译的内容" : "译文将显示在这里";

  // Effective language of THIS pane's content (explicit selection wins, then
  // the detection result, then the resolved pair target).
  const effectivePaneLang: LangCode =
    pane.lang !== "auto"
      ? pane.lang
      : role === "source"
        ? detected !== "auto"
          ? detected
          : "auto"
        : pair.to !== "auto"
          ? pair.to
          : "auto";

  return (
    <section
      className={`pane pane-${role}`}
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
          <span
            className="pane-lang-tag"
            title="本侧内容的语言（保持单一语言，不会与另一侧混排）"
          >
            {effectivePaneLang === "auto"
              ? "语言未定"
              : `本侧：${langLabel(effectivePaneLang)}`}
          </span>
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
              ? `译文语言：${pair.to !== "auto" ? langLabel(pair.to) : "自动"} · 源自 ${
                  detected !== "auto" ? langLabel(detected) : "原文"
                }`
              : `译文语言：${langLabel(pane.lang)} · 源自原文`}
          </div>
        )}
        {role === "source" && (
          <div className="pane-hint">
            {pair.to !== "auto"
              ? `原文语言：${langLabel(effectivePaneLang)} → 译成 ${langLabel(pair.to)}`
              : "请先输入内容"}
          </div>
        )}
      </header>

      <div className="pane-body">
        <CodePaneInput
          value={pane.text}
          link={link}
          flash={flash}
          ariaLabel={role === "source" ? "源文本编辑区" : "译文编辑区"}
          onUserEdit={onEdit}
          onPointer={onPointer}
          onViewReady={onViewReady}
        />
        {pane.text.length === 0 && (
          <div className="cm-placeholder" aria-hidden="true">
            {placeholderHint}
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
