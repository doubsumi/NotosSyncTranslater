import { describe, expect, it } from "vitest";
import {
  changedRange,
  fnv1a,
  mapBlocks,
  rebuildWithTranslations,
  splitBlocks,
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
