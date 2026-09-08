import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncController, type ControllerState } from "./controller";
import type { SegSyncResult } from "./api";

// ---------------------------------------------------------------------------
// Fake backends implementing the segment queue protocol.
// ---------------------------------------------------------------------------
interface SegmentCall {
  doc: string;
  from: string;
  to: string;
  items: Array<{ sid: number; text: string }>;
  alive: number[];
  resolve: (r: SegSyncResult[]) => void;
}

function makeApi(manual = false) {
  const calls: Array<Omit<SegmentCall, "resolve">> = [];
  const pending: SegmentCall[] = [];
  const api = {
    async syncDocSegments(
      doc: string,
      from: string,
      to: string,
      items: Array<{ sid: number; text: string }>,
      alive: number[],
      _signal?: AbortSignal
    ): Promise<SegSyncResult[]> {
      calls.push({ doc, from, to, items, alive });
      if (!manual) {
        return Promise.resolve(
          items.map((item) => ({
            sid: item.sid,
            ok: true as const,
            translated: `[${item.text}]`,
            provider: "fake",
          }))
        );
      }
      return new Promise<SegSyncResult[]>((resolve) => {
        pending.push({ doc, from, to, items, alive, resolve });
      });
    },
    translateBatch: async () => [],
    detect: async () => ({
      lang: "auto" as const,
      confidence: 0,
      script: "other",
      analyzedChars: 0,
    }),
    health: async () => ({ status: "ok", providers: [] }),
  };
  return {
    api,
    calls,
    pending,
    resolveNext(results?: SegSyncResult[]) {
      const call = pending.shift();
      if (!call) throw new Error("no pending segment call");
      const res =
        results ??
        call.items.map((item) => ({
          sid: item.sid,
          ok: true as const,
          translated: `[${item.text}]`,
          provider: "fake",
        }));
      call.resolve(res);
    },
  };
}

interface Ctx {
  ctl: SyncController;
  getState: () => ControllerState;
  calls: ReturnType<typeof makeApi>["calls"];
  pending: ReturnType<typeof makeApi>["pending"];
  resolveNext: ReturnType<typeof makeApi>["resolveNext"];
  toasts: unknown[];
}

function makeController(opts: { debounceMs?: number; manual?: boolean } = {}): Ctx {
  const backend = makeApi(Boolean(opts.manual));
  let latest: ControllerState | null = null;
  const toasts: unknown[] = [];
  const ctl = new SyncController({
    api: backend.api as never,
    debounceMs: opts.debounceMs ?? 200,
    maxWaitMs: 800,
    concurrency: 3,
    onUpdate: (s) => {
      latest = s;
    },
    onToast: (t) => toasts.push(t),
  });
  return {
    ctl,
    getState: () => latest!,
    calls: backend.calls,
    pending: backend.pending,
    resolveNext: backend.resolveNext,
    toasts,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle(ms = 400): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("SyncController v3 — segment queue", () => {
  it("mirror-first: target shows the source, then flips per sentence", async () => {
    const { ctl, getState, pending, resolveNext } = makeController({ manual: true });
    ctl.edit("left", "One. Two. Three.");
    await settle(); // debounce fires, doc built, mirror applied, 3 requests queued

    // Immediately after the requests start, the target is a verbatim mirror.
    expect(getState().right.text).toBe("One. Two. Three.");
    expect(pending.length).toBe(3); // one request per sentence (concurrency 3)

    // Resolve the first sentence: only it flips.
    resolveNext();
    await settle(0);
    expect(getState().right.text).toBe("[One.] Two. Three.");

    resolveNext();
    await settle(0);
    expect(getState().right.text).toBe("[One.] [Two.] Three.");

    resolveNext();
    await settle(0);
    expect(getState().right.text).toBe("[One.] [Two.] [Three.]");
    expect(getState().phase).toBe("idle");
  });

  it("editing submits ONLY the edited sentence id and updates only its text", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two. Three.");
    await settle();
    expect(getState().right.text).toBe("[One.] [Two.] [Three.]");
    const firstDoc = calls[0].doc;

    // Edit the middle sentence.
    ctl.edit("left", "One. Two edited. Three.");
    await settle();
    const lastCall = calls[calls.length - 1];
    expect(lastCall.doc).toBe(firstDoc); // same document queue
    expect(lastCall.items).toEqual([{ sid: 1, text: "Two edited." }]);
    expect(lastCall.alive).toEqual([0, 1, 2]);
    expect(getState().right.text).toBe("[One.] [Two edited.] [Three.]");
  });

  it("inserting a sentence at the start only queues the new sid", async () => {
    const { ctl, calls } = makeController();
    ctl.edit("left", "Alpha. Beta. Gamma.");
    await settle();

    ctl.edit("left", "Zed. Alpha. Beta. Gamma.");
    await settle();
    const last = calls[calls.length - 1];
    expect(last.items).toHaveLength(1);
    expect(last.items[0].text).toBe("Zed.");
    expect(last.items[0].sid).toBe(3); // fresh sid; suffix kept 0,1,2
    expect(last.alive).toEqual([3, 0, 1, 2]);
  });

  it("deleting the last sentence needs no request, mirror just shrinks", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "Alpha. Beta. Gamma.");
    await settle();
    const countBefore = calls.length;

    ctl.edit("left", "Alpha. Beta.");
    await settle();
    expect(calls.length).toBe(countBefore); // no network call
    expect(getState().right.text).toBe("[Alpha.] [Beta.]");
  });

  it("target language change re-queues every sentence under a new pair", async () => {
    const { ctl, calls } = makeController();
    ctl.edit("left", "今天天气很好。我们走吧。");
    await settle();
    const first = calls[0];
    expect(first.to).toBe("en");

    ctl.changeLang("right", "ja");
    await settle();
    const jpCalls = calls.filter((c) => c.to === "ja");
    expect(jpCalls.length).toBeGreaterThanOrEqual(2); // every sentence re-queued
    expect(jpCalls[0].doc).not.toBe(first.doc); // fresh doc queue
  });

  it("alignFor exposes exact per-sentence mapping after sync", async () => {
    const { ctl, getState } = makeController();
    ctl.edit("left", "One. Two. Three.");
    await settle();
    const alignment = ctl.alignFor("left");
    expect(alignment).not.toBeNull();
    const { rows } = alignment!;
    expect(rows).toHaveLength(3);
    expect(rows[0].srcS).toBe(0);
    expect(rows[rows.length - 1].srcE).toBe("One. Two. Three.".length);
    expect(rows[0].dstS).toBe(0);
    expect(rows[rows.length - 1].dstE).toBe(getState().right.text.length);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].srcS).toBeGreaterThanOrEqual(rows[i - 1].srcE);
      expect(rows[i].dstS).toBeGreaterThanOrEqual(rows[i - 1].dstE);
    }
  });

  it("superseded chains never apply or toast stale results", async () => {
    const { ctl, getState, pending, resolveNext, toasts } = makeController({
      manual: true,
    });
    ctl.edit("left", "first draft.");
    await settle();
    expect(pending.length).toBeGreaterThan(0);

    // User keeps typing while the first chain is in flight.
    ctl.edit("left", "second draft.");
    await settle();
    expect(pending.length).toBeGreaterThan(0);

    // Let everything resolve in any order.
    while (pending.length > 0) resolveNext();
    await settle(0);

    expect(getState().right.text).toBe("[second draft.]");
    expect(toasts).toEqual([]); // no bogus failure popup
  });
});
