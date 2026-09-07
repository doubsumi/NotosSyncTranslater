import { describe, expect, it } from "vitest";
import {
  blockRangeForSelection,
  changedRange,
  fnv1a,
  joinSentenceParts,
  mapBlocks,
  rebuildWithTranslations,
  splitBlocks,
  splitSentences,
} from "./blocks";

describe("splitBlocks / layout preservation", () => {
  it("round-trips simple text", () => {
    const text = "alpha\nbeta\ngamma";
    expect(splitBlocks(text).join("\n")).toBe(text);
  });

  it("keeps blank lines and trailing newlines via rebuild", () => {
    const text = "one\n\n\nthree\n\n";
    const blocks = mapBlocks(text);
    const out = rebuildWithTranslations(
      text,
      new Map([
        [0, "一"],
        [1, "三"],
      ])
    );
    expect(out).toBe("一\n\n\n三\n\n");
    expect(blocks.length).toBe(2);
  });

  it("leaves untranslated blocks unchanged", () => {
    const text = "a\nb\nc";
    const out = rebuildWithTranslations(text, new Map([[1, "B"]]));
    expect(out).toBe("a\nB\nc");
  });
});

describe("changedRange", () => {
  it("returns null for identical lists", () => {
    expect(changedRange(["a", "b"], ["a", "b"])).toBeNull();
  });

  it("finds a middle edit", () => {
    expect(changedRange(["a", "b", "c", "d"], ["a", "b", "X", "d"])).toEqual([
      2, 3,
    ]);
  });

  it("handles insertions", () => {
    expect(changedRange(["a", "b"], ["a", "b", "NEW"])).toEqual([2, 3]);
    expect(changedRange(["a", "b", "c"], ["a", "x", "b", "c"])).toEqual([1, 2]);
  });

  it("handles deletions", () => {
    expect(changedRange(["a", "b", "c"], ["a"])).toEqual([1, 1]);
  });

  it("handles full replacement", () => {
    expect(changedRange(["a"], ["x", "y"])).toEqual([0, 2]);
  });
});

describe("fnv1a", () => {
  it("is deterministic and sensitive", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("hello "));
    expect(fnv1a("中文")).not.toBe(fnv1a("中文 "));
  });
});

describe("splitSentences", () => {
  const identity = (block: string): boolean =>
    block === joinSentenceParts(splitSentences(block), splitSentences(block).map((p) => p.text));

  it("round-trips any block (text + ws reconstructs exactly)", () => {
    for (const block of [
      "One. Two. Three.",
      "今天天气很好。我们去散步吧！",
      "Hello world",
      "A  B  C.",
      "U.S. Army. Navy.",
    ]) {
      expect(identity(block)).toBe(true);
    }
  });

  it("splits English sentences on real boundaries only", () => {
    const parts = splitSentences("Mr. Smith went home. He walked away.");
    expect(parts.map((p) => p.text)).toEqual([
      "Mr. Smith went home.",
      "He walked away.",
    ]);
  });

  it("keeps abbreviations and decimals intact", () => {
    expect(splitSentences("Pi is 3.14 and e.g. this one.").length).toBe(1);
  });

  it("splits CJK sentences with no whitespace", () => {
    const parts = splitSentences("今天很好。明天也好。");
    expect(parts.map((p) => p.text)).toEqual(["今天很好。", "明天也好。"]);
    expect(parts.map((p) => p.ws)).toEqual(["", ""]);
  });

  it("preserves inter-sentence whitespace separately", () => {
    const parts = splitSentences("One.  Two.");
    expect(parts[0].ws).toBe("  ");
  });
});

describe("blockRangeForSelection", () => {
  it("maps a selection to its block range", () => {
    const text = "alpha\nbeta\ngamma";
    // 'bet' starts at offset 6, ends at 9 -> block index 1
    expect(blockRangeForSelection(text, 6, 9)).toEqual([1, 1]);
    // spanning alpha and beta
    expect(blockRangeForSelection(text, 2, 9)).toEqual([0, 1]);
  });

  it("returns null for collapsed or empty selections", () => {
    expect(blockRangeForSelection("abc\ndef", 1, 1)).toBeNull();
    expect(blockRangeForSelection("", 0, 0)).toBeNull();
  });
});
