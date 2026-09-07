// ---------------------------------------------------------------------------
// Client-side language detection.
//
// Mirrors the backend heuristic (script ratios + latin stop-words) so that
// language decisions are instant and offline. The server still performs its
// own detection when the client sends `from: "auto"`, so the engine never
// depends on this code being right.
// ---------------------------------------------------------------------------

export type LangCode =
  | "auto"
  | "zh"
  | "en"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "es"
  | "ru"
  | "pt"
  | "it"
  | "ar"
  | "th"
  | "vi"
  | "id"
  | "hi";

export interface LangOption {
  code: LangCode;
  /** Chinese display name. */
  labelZh: string;
  /** English display name. */
  labelEn: string;
}

export const LANG_OPTIONS: readonly LangOption[] = [
  { code: "auto", labelZh: "自动检测", labelEn: "Auto detect" },
  { code: "zh", labelZh: "中文", labelEn: "Chinese" },
  { code: "en", labelZh: "英语", labelEn: "English" },
  { code: "ja", labelZh: "日语", labelEn: "Japanese" },
  { code: "ko", labelZh: "韩语", labelEn: "Korean" },
  { code: "fr", labelZh: "法语", labelEn: "French" },
  { code: "de", labelZh: "德语", labelEn: "German" },
  { code: "es", labelZh: "西班牙语", labelEn: "Spanish" },
  { code: "ru", labelZh: "俄语", labelEn: "Russian" },
  { code: "pt", labelZh: "葡萄牙语", labelEn: "Portuguese" },
  { code: "it", labelZh: "意大利语", labelEn: "Italian" },
  { code: "ar", labelZh: "阿拉伯语", labelEn: "Arabic" },
  { code: "th", labelZh: "泰语", labelEn: "Thai" },
  { code: "vi", labelZh: "越南语", labelEn: "Vietnamese" },
  { code: "id", labelZh: "印尼语", labelEn: "Indonesian" },
  { code: "hi", labelZh: "印地语", labelEn: "Hindi" },
];

const LANG_BY_CODE = new Map(LANG_OPTIONS.map((o) => [o.code, o]));

export function langLabel(code: LangCode): string {
  return LANG_BY_CODE.get(code)?.labelZh ?? code;
}

/** Codes accepted as an explicit *target* (everything except `auto`). */
export const TARGET_CODES = LANG_OPTIONS.filter((o) => o.code !== "auto").map(
  (o) => o.code
);

// ---------------------------------------------------------------------------
// Character scripts (Unicode ranges, UAX #24)
// ---------------------------------------------------------------------------
function isHan(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
}
function isHiragana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c >= 0x3040 && c <= 0x309f;
}
function isKatakana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x30a0 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff);
}
function isHangul(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x3130 && c <= 0x318f)
  );
}
function isCyrillic(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x0400 && c <= 0x04ff) || (c >= 0x0500 && c <= 0x052f);
}
function isThai(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c >= 0x0e00 && c <= 0x0e7f;
}
function isArabic(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f);
}
function isLatin(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0xc0 && c <= 0x24f) ||
    (c >= 0x1e00 && c <= 0x1eff)
  );
}

// ---------------------------------------------------------------------------
// Latin stop-word scoring (compact lists, one linear pass)
// ---------------------------------------------------------------------------
const STOPWORDS: Record<string, ReadonlySet<string>> = {
  en: new Set(
    "the of and to in a is for that on it with as you this be are was not but have by at or from they we an he she i has had will would can could should do does did his her their them my your its about which who when where what why how if then than so just more most some any all been there here out up down into over under again further once also because only very".split(" ")
  ),
  fr: new Set(
    "le la les de du des et un une est sont que qui dans pour en au aux ce cette ces il elle ils elles on nous vous je tu se sur pas plus avec mais ou notre vos leur leurs son sa ses mon ma mes ne ni si comme tout".split(" ")
  ),
  de: new Set(
    "der die das und ist sind ich du er sie es wir ihr zu mich mir dem den ein eine einen einer nicht mit auch noch wie bei im in auf für von aus über unter wenn als dann was welche oder aber schon nur kann können muss müssen war waren sein".split(" ")
  ),
  es: new Set(
    "el la los las de del y que es son un una unos unas en por para con no si se su sus me te le lo les como mas pero este esta estos estas ese esa al a yo tu mi mis muy cuando donde quien hay había han ha".split(" ")
  ),
  it: new Set(
    "il lo la le i gli di del della dei delle che e ed un una per con non si sono questo questa questi queste suo sua suoi sue mio mia tuo tua noi voi loro anche o se come da dal nel nella negli nelle".split(" ")
  ),
  pt: new Set(
    "o a os as de do da dos das e que um uma em para por com não se é mais como mas no na nos nas pelo pela pelos pelo ao aos às ele ela eles elas eu você seu sua seus suas meu minha me te lhe este esta isso aquilo quando onde há tinha foi".split(" ")
  ),
};

const WORD_RE = /[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]+/g;

export interface ClientDetection {
  code: Exclude<LangCode, "auto"> | "auto";
  script: string;
}

export function detectLanguage(text: string): ClientDetection {
  let han = 0,
    latin = 0,
    kana = 0,
    hangul = 0,
    cyr = 0,
    thai = 0,
    arab = 0;
  for (const ch of text) {
    if (isHan(ch)) han++;
    else if (isHiragana(ch) || isKatakana(ch)) kana++;
    else if (isHangul(ch)) hangul++;
    else if (isCyrillic(ch)) cyr++;
    else if (isThai(ch)) thai++;
    else if (isArabic(ch)) arab++;
    else if (isLatin(ch)) latin++;
  }
  const total = han + latin + kana + hangul + cyr + thai + arab;
  if (total === 0) return { code: "auto", script: "other" };
  if (cyr / total >= 0.5) return { code: "ru", script: "cyrillic" };
  if (thai / total >= 0.5) return { code: "th", script: "thai" };
  if (arab / total >= 0.5) return { code: "ar", script: "arabic" };
  if (kana > 0 && (kana / total >= 0.06 || han === 0))
    return { code: "ja", script: "kana" };
  if (hangul / total >= 0.4) return { code: "ko", script: "hangul" };
  if (han > 0 && han / total >= 0.5) return { code: "zh", script: "han" };

  if (latin / total >= 0.8) {
    const words: string[] = [];
    let m: RegExpExecArray | null;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      words.push(m[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    }
    if (words.length >= 3) {
      const scores: Record<string, number> = {};
      let best = "";
      let bestN = 0;
      for (const [code, set] of Object.entries(STOPWORDS)) {
        let n = 0;
        for (const w of words) if (set.has(w)) n++;
        scores[code] = n;
        if (n > bestN) {
          bestN = n;
          best = code;
        }
      }
      if (bestN >= 2) {
        let second = 0;
        for (const [code, n] of Object.entries(scores)) {
          if (code !== best && n > second) second = n;
        }
        if (bestN > second) return { code: best as Exclude<LangCode, "auto">, script: "latin" };
      }
    }
    // Ambiguous latin: ask the upstream engine to decide.
    return { code: "auto", script: "latin" };
  }
  return { code: "auto", script: "other" };
}

/**
 * The auto pair rule required by the product:
 *   Chinese  -> English
 *   English  -> Chinese
 *   anything else -> Chinese
 */
export function defaultTargetFor(sourceLang: Exclude<LangCode, "auto">): LangCode {
  return sourceLang === "zh" ? "en" : "zh";
}
