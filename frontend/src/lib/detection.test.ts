import { describe, expect, it } from "vitest";
import {
  defaultTargetFor,
  detectLanguage,
  LANG_OPTIONS,
} from "./detection";

describe("detectLanguage", () => {
  it("detects simplified Chinese", () => {
    expect(detectLanguage("今天天气很好，我们一起去散步吧。").code).toBe("zh");
  });

  it("detects Japanese via kana", () => {
    expect(detectLanguage("今日は天気がいいですね。").code).toBe("ja");
  });

  it("detects Korean", () => {
    expect(detectLanguage("오늘 날씨가 정말 좋아요.").code).toBe("ko");
  });

  it("detects Cyrillic as Russian", () => {
    expect(detectLanguage("Сегодня хорошая погода.").code).toBe("ru");
  });

  it("detects English from stop words", () => {
    expect(
      detectLanguage("The quick brown fox jumps over the lazy dog.").code
    ).toBe("en");
  });

  it("detects French", () => {
    expect(detectLanguage("Le chat est sur le tapis et il dort.").code).toBe(
      "fr"
    );
  });

  it("detects German", () => {
    expect(
      detectLanguage("Der Hund läuft durch den großen Garten und spielt.").code
    ).toBe("de");
  });

  it("leaves empty/ambiguous text as auto", () => {
    expect(detectLanguage("").code).toBe("auto");
    expect(detectLanguage("12345 !!!").code).toBe("auto");
  });
});

describe("defaultTargetFor (auto pair rules)", () => {
  it("maps zh -> en", () => {
    expect(defaultTargetFor("zh")).toBe("en");
  });

  it("maps en -> zh", () => {
    expect(defaultTargetFor("en")).toBe("zh");
  });

  it("maps any other language -> zh", () => {
    expect(defaultTargetFor("ja")).toBe("zh");
    expect(defaultTargetFor("fr")).toBe("zh");
    expect(defaultTargetFor("ko")).toBe("zh");
  });
});

describe("LANG_OPTIONS", () => {
  it("contains auto plus targets and unique codes", () => {
    const codes = LANG_OPTIONS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("auto");
    expect(codes).toContain("zh");
    expect(codes).toContain("en");
  });
});
