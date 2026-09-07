import { LANG_OPTIONS, type LangCode } from "../lib/detection";

interface Props {
  value: LangCode;
  onChange: (code: LangCode) => void;
  ariaLabel: string;
  className?: string;
}

/** A styled native <select> over the supported languages. */
export function LanguageSelect({ value, onChange, ariaLabel, className }: Props): JSX.Element {
  return (
    <select
      className={className ?? "lang-select"}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as LangCode)}
    >
      {LANG_OPTIONS.map((opt) => (
        <option key={opt.code} value={opt.code}>
          {opt.labelZh}
        </option>
      ))}
    </select>
  );
}
