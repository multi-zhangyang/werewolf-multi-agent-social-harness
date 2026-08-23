/**
 * Bounded rolling event window.
 *
 * The room keeps two event buffers — the short SSE backlog and the longer
 * replay-anchor list. Both are capped by entry count AND by serialized
 * bytes: `world.*-frame` envelopes embed full snapshots, so a count-only cap
 * lets a handful of rooms grow multi-hundred-MB checkpoints (§31). Trimming
 * is O(1) amortized via a head index with occasional compaction; callers
 * read through `toArray()`/`last()` and never mutate the retained window.
 */

export interface EnvelopeWindowBudget {
  /** Hard ceiling on retained entries. */
  maxCount: number;
  /** Hard ceiling on total serialized bytes of retained entries. */
  maxBytes: number;
  /** Entries never dropped below this many, even over budget. */
  minKeep: number;
}

export class EnvelopeWindow<T> {
  private readonly items: T[] = [];
  private head = 0;
  private bytes = 0;

  constructor(
    private readonly budget: EnvelopeWindowBudget,
    private readonly sizeOf: (entry: T) => number
  ) {}

  get length(): number {
    return this.items.length - this.head;
  }

  push(entry: T): void {
    this.items.push(entry);
    this.bytes += this.sizeOf(entry);
    this.trim();
  }

  pushAll(entries: Iterable<T>): void {
    for (const entry of entries) {
      this.items.push(entry);
      this.bytes += this.sizeOf(entry);
    }
    this.trim();
  }

  last(): T | undefined {
    return this.length ? this.items[this.items.length - 1] : undefined;
  }

  /** The retained window, oldest first (a fresh array — safe to clone/filter). */
  toArray(): T[] {
    return this.length ? this.items.slice(this.head) : [];
  }

  private trim(): void {
    while (
      this.length > this.budget.minKeep
      && (this.length > this.budget.maxCount || this.bytes > this.budget.maxBytes)
    ) {
      this.bytes -= this.sizeOf(this.items[this.head]);
      this.head += 1;
    }
    // Compact occasionally so long-lived rooms do not pin dead head entries.
    if (this.head > 256 && this.head * 2 > this.items.length) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
  }
}