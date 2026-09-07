// ---------------------------------------------------------------------------
// Commercial-grade debounce with a maximum-wait guarantee.
//
// A plain trailing debounce starves while the user types continuously (the
// callback never fires). This implementation guarantees the callback runs at
// least every `maxWait` ms even during non-stop input, while still collapsing
// rapid keystrokes into a single trailing call once the user pauses.
// ---------------------------------------------------------------------------

export interface Debounced {
  /** Call `fn` after a pause, or after maxWait of continuous triggering. */
  schedule(fn: () => void): void;
  /** Drop any pending call. */
  cancel(): void;
  /** True when a call is waiting to fire. */
  get pending(): boolean;
}

export function debounce(waitMs: number, maxWaitMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueTimer: ReturnType<typeof setTimeout> | null = null;
  let latest: (() => void) | null = null;
  let firstAt = 0;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (dueTimer !== null) {
      clearTimeout(dueTimer);
      dueTimer = null;
    }
  };

  const fire = (): void => {
    const fn = latest;
    clear();
    latest = null;
    if (fn) fn();
  };

  return {
    schedule(fn: () => void): void {
      latest = fn;
      const now = Date.now();
      if (timer === null) firstAt = now; // first trigger of this burst
      clear();
      timer = setTimeout(fire, waitMs);
      const elapsed = now - firstAt;
      const remaining = Math.max(0, maxWaitMs - elapsed);
      if (remaining <= 0) {
        fire(); // waited long enough — run immediately
        return;
      }
      dueTimer = setTimeout(fire, remaining);
    },
    cancel(): void {
      clear();
      latest = null;
    },
    get pending(): boolean {
      return latest !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tiny rate gate: no more than one call per `minGapMs`, queueing the newest
// request to run right after the current one finishes.
// ---------------------------------------------------------------------------
export interface RateGate {
  /** Queue `fn`; it runs when the gate allows (FIFO, coalescing identical
   *  queued work by `key`). Returns a promise resolving to its result. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function rateGate(minGapMs: number): RateGate {
  let lastAt = 0;
  let queue: Array<{ key: string; fn: () => unknown }> = [];
  let running = false;

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (queue.length > 0) {
        const item = queue.shift()!;
        const wait = lastAt + minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastAt = Date.now();
        try {
          await item.fn();
        } catch {
          /* result promise handles rejection */
        }
      }
    } finally {
      running = false;
      if (queue.length > 0) void pump(); // refilled while draining
    }
  };

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        // Coalesce: if the same work is already queued, drop the older one.
        const existing = queue.findIndex((q) => q.key === key);
        if (existing !== -1) queue.splice(existing, 1);
        queue.push({
          key,
          fn: () => {
            fn().then(resolve, reject);
          },
        });
        void pump();
      });
    },
  };
}
