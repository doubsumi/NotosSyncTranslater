import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncController, type ControllerState } from "./controller";
import type { BatchItem, BatchResult } from "./api";

/** Deterministic fake backend: wraps every text in brackets. */
function fakeApi(onBatch?: (items: BatchItem[]) => void) {
  return {
    async translateBatch(
      items: BatchItem[],
      _signal?: AbortSignal
    ): Promise<BatchResult[]> {
      onBatch?.(items);
      return items.map((item) => ({
        id: item.id,
        ok: true as const,
        translated: `[${item.text}]`,
        from: item.from,
        to: item.to,
        provider: "fake",
        cacheHits: 0,
      }));
    },
    async detect(_text: string) {
      return { lang: "auto" as const, confidence: 0, script: "other", analyzedChars: 0 };
    },
    async health() {
      return { status: "ok", providers: [] };
    },
  };
}

function makeController(
  onBatch?: (items: BatchItem[]) => void
): { ctl: SyncController; getState: () => ControllerState; batches: BatchItem[][] } {
  const batches: BatchItem[][] = [];
  const api = fakeApi((items) => {
    batches.push(items);
    onBatch?.(items);
  });
  let latest: ControllerState | null = null;
  const ctl = new SyncController({
    api,
    debounceMs: 200,
    maxWaitMs: 800,
    waveSize: 10,
    onUpdate: (s) => {
      latest = s;
    },
    onToast: () => undefined,
  });
  return { ctl, getState: () => latest!, batches };
}

/** API whose batch promises resolve only when the test says so. */
function manualApi() {
  const pending: Array<{
    items: BatchItem[];
    resolve: (r: BatchResult[]) => void;
  }> = [];
  const api = {
    translateBatch(items: BatchItem[]): Promise<BatchResult[]> {
      return new Promise<BatchResult[]>((resolve) => {
        pending.push({ items, resolve });
      });
    },
    async detect(_text: string) {
      return { lang: "auto" as const, confidence: 0, script: "other", analyzedChars: 0 };
    },
    async health() {
      return { status: "ok", providers: [] };
    },
  };
  return {
    api,
    get pendingCount(): number {
      return pending.length;
    },
    resolveAll(): void {
      const queue = pending.splice(0);
      for (const p of queue) {
        p.resolve(
          p.items.map((item) => ({
            id: item.id,
            ok: true as const,
            translated: `[${item.text}]`,
            from: item.from,
            to: item.to,
            provider: "fake",
            cacheHits: 0,
          }))
        );
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400); // debounce + microtasks
}

describe("SyncController", () => {
  it("debounces typing into a single request and shows the translation", async () => {
    const { ctl, getState, batches } = makeController();
    ctl.edit("left", "Hello world.");
    ctl.edit("left", "Hello world, how are you?");
    await settle();

    expect(batches.length).toBe(1); // collapsed burst
    expect(batches[0][0].text).toBe("Hello world, how are you?");
    expect(getState().right.text).toBe("[Hello world, how are you?]");
    expect(getState().phase).toBe("idle");
  });

  it("does not re-request unchanged content", async () => {
    const { ctl, batches } = makeController();
    ctl.edit("left", "hello there");
    await settle();
    expect(batches.length).toBe(1);

    // Editing the same text again must be a no-op (applied fast-path).
    ctl.edit("left", "hello there");
    await settle();
    expect(batches.length).toBe(1);
  });

  it("requests only new blocks thanks to translation memory", async () => {
    const { ctl, batches } = makeController();
    ctl.edit("left", "first line\nsecond line");
    await settle();
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(2);

    // Change only the second block.
    ctl.edit("left", "first line\nsecond line EDITED");
    await settle();
    expect(batches.length).toBe(2);
    expect(batches[1].length).toBe(1); // only the edited block
    expect(batches[1][0].text).toBe("second line EDITED");
  });

  it("editing one sentence requests and updates only that sentence", async () => {
    const { ctl, getState, batches } = makeController();
    ctl.edit("left", "One. Two. Three.");
    await settle();
    expect(batches.length).toBe(1);
    expect(batches[0].map((b) => b.text).sort()).toEqual(["One.", "Three.", "Two."]);
    expect(getState().right.text).toBe("[One.] [Two.] [Three.]");

    // Touch the middle sentence only.
    ctl.edit("left", "One. Two edited. Three.");
    await settle();
    expect(batches.length).toBe(2);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1][0].text).toBe("Two edited.");
    expect(getState().right.text).toBe("[One.] [Two edited.] [Three.]");
  });

  it("is bidirectional: editing the right pane translates back to the left", async () => {
    const { ctl, getState } = makeController();
    ctl.edit("left", "你好，世界。");
    await settle();
    expect(getState().right.text.length).toBeGreaterThan(0);

    ctl.edit("right", "Thank you.");
    await settle();
    expect(getState().left.text).toBe("[Thank you.]");
  });

  it("skips when both panes hold identical text (no echo loops)", async () => {
    const { ctl, batches } = makeController();
    ctl.edit("left", "identical");
    ctl.edit("right", "identical"); // right now mirrors source exactly
    await settle();
    // The second edit sees equal panes -> no request fired for it.
    expect(batches.length).toBeLessThanOrEqual(1);
  });

  it("auto pairs Chinese text to English target", async () => {
    const { ctl, getState, batches } = makeController();
    ctl.edit("left", "今天天气很好。");
    await settle();
    expect(batches[0][0].from).toBe("zh");
    expect(batches[0][0].to).toBe("en");
    expect(getState().right.text).toBe("[今天天气很好。]");
  });

  it("clears the target when the source is emptied", async () => {
    const { ctl, getState } = makeController();
    ctl.edit("left", "some content here");
    await settle();
    expect(getState().right.text).not.toBe("");

    ctl.edit("left", "");
    await settle();
    expect(getState().right.text).toBe("");
  });

  it("language switch triggers a fresh sync", async () => {
    const { ctl, batches } = makeController();
    ctl.edit("left", "今天天气很好。");
    await settle();
    expect(batches[0][0].to).toBe("en"); // auto target for Chinese

    ctl.changeLang("right", "ja"); // explicit target override
    await settle();
    const last = batches[batches.length - 1];
    expect(last[0].to).toBe("ja");
  });

  it("superseded chains never apply or toast stale results", async () => {
    const manual = manualApi();
    const toasts: unknown[] = [];
    let latest: ControllerState | null = null;
    const ctl = new SyncController({
      api: manual.api,
      debounceMs: 200,
      maxWaitMs: 800,
      onUpdate: (s) => {
        latest = s;
      },
      onToast: (t) => toasts.push(t),
    });

    ctl.edit("left", "first draft");
    await settle(); // first chain starts and stays in flight
    expect(manual.pendingCount).toBe(1);

    // The user keeps typing while the request is flying.
    ctl.edit("left", "second draft");
    await settle(); // new debounce burst supersedes the old chain

    // Now let everything settle: the old response must be discarded.
    manual.resolveAll();
    await settle();

    expect(latest!.right.text).toBe("[second draft]");
    expect(toasts).toEqual([]); // no bogus "translation failed" popup
  });
});
