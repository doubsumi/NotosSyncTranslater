// ---------------------------------------------------------------------------
// Client-side translation memory (session-scoped).
//
// Remembers every (language pair, block) translation of this session so that:
//   * repeated pastes return instantly with zero network traffic,
//   * undoing an edit snaps straight back to the previous translation,
//   * only genuinely new block content is ever sent to the server.
// LRU-capped Map; eviction is O(1) amortised via Map insertion order.
// ---------------------------------------------------------------------------

import { fnv1a } from "./blocks";
import type { LangCode } from "./detection";

const DEFAULT_CAP = 4000;

interface Entry {
  blockText: string;
  translation: string;
}

export class TranslationMemory {
  private readonly map = new Map<number, Entry>();
  private readonly cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.cap = cap;
  }

  key(from: LangCode, to: LangCode, blockText: string): number {
    return fnv1a(`${from}\u0001${to}\u0001${blockText}`);
  }

  get(from: LangCode, to: LangCode, blockText: string): string | undefined {
    const k = this.key(from, to, blockText);
    const entry = this.map.get(k);
    if (entry === undefined || entry.blockText !== blockText) return undefined;
    // LRU touch.
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.translation;
  }

  set(from: LangCode, to: LangCode, blockText: string, translation: string): void {
    const k = this.key(from, to, blockText);
    this.map.delete(k);
    this.map.set(k, { blockText, translation });
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** True when at least one block of `blocks` has no cached translation. */
  hasAll(from: LangCode, to: LangCode, blocks: readonly string[]): boolean {
    return blocks.every((b) => this.get(from, to, b) !== undefined);
  }

  get size(): number {
    return this.map.size;
  }
}
