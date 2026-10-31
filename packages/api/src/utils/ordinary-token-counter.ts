import o200kBase from 'js-tiktoken/ranks/o200k_base';

interface Merge {
  rank: number;
  left: number;
  middle: number;
  end: number;
}

function earlier(a: Merge, b: Merge): boolean {
  return a.rank < b.rank || (a.rank === b.rank && a.left < b.left);
}

/** Rank first, then leftmost occurrence, as in js-tiktoken's exhaustive scan. */
class MergeQueue {
  private readonly items: Merge[] = [];

  push(merge: Merge): void {
    let index = this.items.length;
    this.items.push(merge);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!earlier(merge, this.items[parent])) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = merge;
  }

  pop(): Merge | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0 || !last) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && earlier(this.items[child + 1], this.items[child])) child++;
      if (!earlier(this.items[child], last)) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

/**
 * Count one regex piece represented as a Latin-1 string of UTF-8 bytes.
 * @internal The vocabulary must contain every single byte (o200k_base does).
 * Byte keys are bijective, not decoded Unicode, so no byte distinctions are lost.
 */
export function countBytePairTokens(piece: string, ranks: ReadonlyMap<string, number>, maxTokenBytes: number): number {
  if (!piece.length) return 0;
  if (piece.length <= maxTokenBytes && ranks.has(piece)) return 1;

  // A live segment starts at its original byte offset. next[start] is its end;
  // removed starts have next=-1. The terminal offset is a non-mergeable sentinel.
  const next = new Int32Array(piece.length + 1);
  const previous = new Int32Array(piece.length + 1);
  for (let i = 0; i <= piece.length; i++) {
    next[i] = i + 1;
    previous[i] = i - 1;
  }
  const queue = new MergeQueue();
  function offer(left: number): void {
    const middle = next[left];
    if (middle >= piece.length) return;
    const end = next[middle];
    // No vocabulary entry can span more bytes than its longest token. This
    // bounds lookup work even when the input is an arbitrarily long regex piece.
    if (end - left > maxTokenBytes) return;
    const rank = ranks.get(piece.slice(left, end));
    if (rank !== undefined) queue.push({ rank, left, middle, end });
  }
  for (let i = 0; i < piece.length - 1; i++) offer(i);

  let count = piece.length;
  for (let merge = queue.pop(); merge; merge = queue.pop()) {
    const { left, middle, end } = merge;
    // Both boundaries must match: either participant may have been merged since
    // this candidate was queued. Merely checking that 'left' is live is unsafe.
    if (next[left] !== middle || next[middle] !== end) continue;
    next[left] = end;
    next[middle] = -1;
    previous[end] = left;
    count--;
    if (previous[left] >= 0) offer(previous[left]);
    offer(left);
  }
  return count;
}

interface Vocabulary {
  ranks: ReadonlyMap<string, number>;
  maxTokenBytes: number;
}

let vocabulary: Vocabulary | undefined;

function getVocabulary(): Vocabulary {
  if (vocabulary) return vocabulary;
  const ranks = new Map<string, number>();
  let maxTokenBytes = 0;
  // Public compressed vocabulary format used by js-tiktoken's constructor:
  // marker, starting rank, then consecutive base64-encoded byte tokens.
  for (const line of o200kBase.bpe_ranks.split('\n')) {
    if (!line) continue;
    const [, offset, ...tokens] = line.split(' ');
    const firstRank = Number.parseInt(offset, 10);
    for (let i = 0; i < tokens.length; i++) {
      const bytes = Buffer.from(tokens[i], 'base64').toString('latin1');
      ranks.set(bytes, firstRank + i);
      maxTokenBytes = Math.max(maxTokenBytes, bytes.length);
    }
  }
  vocabulary = { ranks, maxTokenBytes };
  return vocabulary;
}

/** Exact o200k_base count with no special tokens allowed or disallowed. */
export function countOrdinaryTokens(text: string): number {
  const { ranks, maxTokenBytes } = getVocabulary();
  // Same regex and UTF-8 conversion as encodingForModel('gpt-4o').encode(..., [],
  // []). With allowedSpecial=[], control-token literals are just ordinary text.
  // A fresh regex prevents lastIndex state leaking between calls.
  const pieces = new RegExp(o200kBase.pat_str, 'ug');
  let count = 0;
  for (const match of text.matchAll(pieces)) {
    const bytes = Buffer.from(match[0], 'utf8').toString('latin1');
    count += countBytePairTokens(bytes, ranks, maxTokenBytes);
  }
  return count;
}
