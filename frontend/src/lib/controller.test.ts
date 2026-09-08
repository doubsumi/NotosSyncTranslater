import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncController, type ControllerState } from "./controller";
import type { SegSyncResult } from "./api";

interface Call {
  doc: string;
  from: string;
  to: string;
  items: Array<{ sid: number; text: string }>;
  alive: number[];
}

interface PendingCall extends Call {
  resolve: (r: SegSyncResult[]) => void;
}

function makeApi(manual = false) {
  const calls: Call[] = [];
  const pending: PendingCall[] = [];
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
      const wrap = (items: Array<{ sid: number; text: string }>): SegSyncResult[] =>
        items.map((i) => ({
          sid: i.sid,
          ok: true as const,
          translated: `[${i.text}]`,
          provider: "fake",
        }));
      if (!manual) return Promise.resolve(wrap(items));
      return new Promise((resolve) => {
        pending.push({ doc, from, to, items, alive, resolve });
      });
    },
    translateBatch: async () => [],
    detect: async () => ({ lang: "auto" as const, confidence: 0, script: "other", analyzedChars: 0 }),
    health: async () => ({ status: "ok", providers: [] }),
  };
  return {
    api,
    calls,
    pending,
    resolveNext() {
      const p = pending.shift();
      if (!p) throw new Error("no pending call");
      p.resolve(p.items.map((i) => ({ sid: i.sid, ok: true as const, translated: `[${i.text}]`, provider: "fake" })));
    },
  };
}

interface Ctx {
  ctl: SyncController;
  getState: () => ControllerState;
  calls: Call[];
  pending: PendingCall[];
  resolveNext: () => void;
  toasts: unknown[];
}

function makeController(manual = false): Ctx {
  const backend = makeApi(manual);
  let latest: ControllerState | null = null;
  const toasts: unknown[] = [];
  const ctl = new SyncController({
    api: backend.api as never,
    debounceMs: 200,
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function settle(ms = 400): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("SyncController v6 — bilingual segment table", () => {
  it("initial forward sync translates one request per sentence", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.items[0].text).sort()).toEqual(["One.", "Two."]);
    expect(getState().right.text).toBe("[One.] [Two.]");
    expect(getState().left.text).toBe("One. Two.");
  });

  it("editing one source sentence requests only that sid and updates only it", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    const n0 = calls.length;

    ctl.edit("left", "One revised. Two.");
    await settle();
    expect(calls.length).toBe(n0 + 1);
    expect(calls[n0].items).toEqual([{ sid: 1, text: "One revised." }]);
    expect(getState().right.text).toBe("[One revised.] [Two.]");
  });

  it("editing one translation sentence back-syncs only that anchor sentence", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    const leftDoc = calls[0].doc;
    const n0 = calls.length;

    ctl.edit("right", "[One.] [Two new.]");
    await settle();
    expect(calls.length).toBe(n0 + 1);
    const rev = calls[n0];
    expect(rev.doc).not.toBe(leftDoc);
    expect(rev.items).toEqual([{ sid: 2, text: "[Two new.]" }]);
    expect(getState().left.text).toBe("One. [[Two new.]]");
    expect(getState().right.text).toBe("[One.] [Two new.]");
  });

  it("appending a sentence on the translation side inserts it into the anchor", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    const n0 = calls.length;

    ctl.edit("right", "[One.] [Two.]\n[Three.]");
    await settle();
    expect(calls.length).toBe(n0 + 1);
    expect(calls[n0].items).toEqual([{ sid: 3, text: "[Three.]" }]);
    expect(getState().left.text).toBe("One. Two.\n[[Three.]]");
    expect(getState().right.text).toBe("[One.] [Two.]\n[Three.]");
  });

  it("inserting a sentence mid-paragraph only translates the new sentence", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    const n0 = calls.length;

    ctl.edit("right", "[One.] [Mid.] [Two.]");
    await settle();
    expect(calls.length).toBe(n0 + 1);
    expect(calls[n0].items[0].text).toBe("[Mid.]");
    expect(getState().left.text).toBe("One. [[Mid.]] Two.");
  });

  it("deleting a sentence removes its counterpart without extra requests", async () => {
    const { ctl, getState, calls } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    const n0 = calls.length;

    ctl.edit("right", "[One.]");
    await settle();
    expect(calls.length).toBe(n0); // nothing to translate
    expect(getState().left.text).toBe("One.");
    expect(getState().right.text).toBe("[One.]");
  });

  it("alignFor exposes one row per sentence over the shared table", async () => {
    const { ctl, getState } = makeController();
    ctl.edit("left", "One. Two.");
    await settle();
    const a = ctl.alignFor("left");
    expect(a).not.toBeNull();
    const rows = a!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].srcS).toBe(0);
    expect(rows[rows.length - 1].srcE).toBe("One. Two.".length);
    expect(rows[rows.length - 1].dstE).toBe(getState().right.text.length);
  });

  it("superseded chains never apply or toast stale results", async () => {
    const { ctl, getState, pending, resolveNext, toasts } = makeController(true);
    ctl.edit("left", "first draft.");
    await settle();
    expect(pending.length).toBeGreaterThan(0);

    ctl.edit("left", "second draft.");
    await settle();
    while (pending.length > 0) resolveNext();
    await settle(0);

    expect(getState().right.text).toBe("[second draft.]");
    expect(toasts).toEqual([]);
  });
});
