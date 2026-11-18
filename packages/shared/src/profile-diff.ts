/**
 * Pure mechanical line + intra-line diff for whole-file Profile replacement proposals.
 *
 * Browser-safe (zero Node builtins). Uses linear-space Myers divide-and-conquer (O(N+M) memory)
 * with shared-vocabulary reduction and bounded edit depth so worst-case multi-thousand-line
 * replacements remain fast and memory-safe while preserving every physical line and EOF flag.
 */

export interface InlineDiffSegment {
  type: 'equal' | 'remove' | 'add';
  text: string;
}

export interface ProfileDiffLine {
  type: 'context' | 'remove' | 'add';
  content: string;
  oldLine: number | null;
  newLine: number | null;
  noNewlineAtEof?: boolean;
  segments?: InlineDiffSegment[];
}

export interface ProfileDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ProfileDiffLine[];
}

export interface ProfileLineDiff {
  identical: boolean;
  initialWrite: boolean;
  addedLineCount: number;
  removedLineCount: number;
  beforeLineCount: number;
  afterLineCount: number;
  hunks: ProfileDiffHunk[];
  unifiedDiff: string;
}

type EditOp =
  | { type: 'equal'; oldIndex: number; newIndex: number }
  | { type: 'remove'; oldIndex: number }
  | { type: 'add'; newIndex: number };

interface MiddleSnake {
  xStart: number;
  yStart: number;
  xEnd: number;
  yEnd: number;
}

interface SliceBounds {
  left: readonly string[];
  l0: number;
  n: number;
  right: readonly string[];
  r0: number;
  m: number;
  offset: number;
}

const MAX_INLINE_CHAR_LEN = 400;
const MIN_INLINE_SIMILARITY = 0.35;
const MAX_PAIRABLE_RUN = 8;
/** Caps per-subproblem bidirectional half-depth (D <= 4096) so adversarial inputs stay fast. */
const MAX_MYERS_HALF_D = 2048;

function splitPhysicalLines(text: string): string[] {
  if (text === '') return [];
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function stripLineEnding(raw: string): { content: string; noNewlineAtEof: boolean } {
  if (raw.endsWith('\n')) return { content: raw.slice(0, -1), noNewlineAtEof: false };
  return { content: raw, noNewlineAtEof: true };
}

function alignedStart(minVal: number, parityTarget: number): number {
  return ((minVal - parityTarget) & 1) !== 0 ? minVal + 1 : minVal;
}

function pickForwardX(leftX: number, downX: number): number {
  if (leftX === -1) return downX;
  if (downX !== -1 && leftX < downX) return downX;
  return leftX + 1;
}

function advanceForwardSnake(s: SliceBounds, startX: number, startY: number): { x: number; y: number } {
  let x = startX;
  let y = startY;
  while (x < s.n && y < s.m && s.left[s.l0 + x] === s.right[s.r0 + y]) {
    x++;
    y++;
  }
  return { x, y };
}

function stepForward(s: SliceBounds, d: number, odd: boolean, vf: Int32Array, vb: Int32Array): MiddleSnake | null {
  const kMin = alignedStart(Math.max(-d, -s.m), d);
  const kMax = Math.min(d, s.n);

  for (let k = kMin; k <= kMax; k += 2) {
    const idx = s.offset + k;
    const leftX = vf[idx - 1] ?? -1;
    const downX = vf[idx + 1] ?? -1;
    if (leftX === -1 && downX === -1) continue;

    const xStart = pickForwardX(leftX, downX);
    const yStart = xStart - k;
    if (xStart > s.n || yStart > s.m) {
      vf[idx] = -1;
      continue;
    }

    const { x, y } = advanceForwardSnake(s, xStart, yStart);
    vf[idx] = x;

    if (odd && (vb[idx] ?? s.n + 1) <= x) {
      return { xStart, yStart, xEnd: x, yEnd: y };
    }
  }
  return null;
}

function pickBackwardX(upX: number, rightX: number, n: number): number {
  if (rightX > n) return upX;
  if (upX <= n && upX <= rightX - 1) return upX;
  return rightX - 1;
}

function advanceBackwardSnake(s: SliceBounds, endX: number, endY: number): { x: number; y: number } {
  let x = endX;
  let y = endY;
  while (x > 0 && y > 0 && s.left[s.l0 + x - 1] === s.right[s.r0 + y - 1]) {
    x--;
    y--;
  }
  return { x, y };
}

function stepBackward(
  s: SliceBounds,
  d: number,
  delta: number,
  odd: boolean,
  vf: Int32Array,
  vb: Int32Array,
): MiddleSnake | null {
  const kMin = alignedStart(Math.max(delta - d, -s.m), delta + d);
  const kMax = Math.min(delta + d, s.n);

  for (let k = kMin; k <= kMax; k += 2) {
    const idx = s.offset + k;
    const upX = vb[idx - 1] ?? s.n + 1;
    const rightX = vb[idx + 1] ?? s.n + 1;
    if (upX > s.n && rightX > s.n) continue;

    const xEnd = pickBackwardX(upX, rightX, s.n);
    const yEnd = xEnd - k;
    if (xEnd < 0 || yEnd < 0) {
      vb[idx] = s.n + 1;
      continue;
    }

    const { x, y } = advanceBackwardSnake(s, xEnd, yEnd);
    vb[idx] = x;

    if (!odd && (vf[idx] ?? -1) >= x) {
      return { xStart: x, yStart: y, xEnd, yEnd };
    }
  }
  return null;
}

function findMiddleSnake(
  left: readonly string[],
  l0: number,
  l1: number,
  right: readonly string[],
  r0: number,
  r1: number,
  vf: Int32Array,
  vb: Int32Array,
): MiddleSnake | null {
  const n = l1 - l0;
  const m = r1 - r0;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const offset = m + 2;
  const span = n + m + 5;

  vf.fill(-1, 0, span);
  vb.fill(n + 1, 0, span);
  vf[offset] = 0;
  vb[offset + delta] = n;

  const bounds: SliceBounds = { left, l0, n, right, r0, m, offset };
  const maxD = Math.min((n + m + 1) >> 1, MAX_MYERS_HALF_D);

  for (let d = 1; d <= maxD; d++) {
    const fwd = stepForward(bounds, d, odd, vf, vb);
    if (fwd) return fwd;
    const bwd = stepBackward(bounds, d, delta, odd, vf, vb);
    if (bwd) return bwd;
  }
  return null;
}

function matchSingleElement(
  left: readonly string[],
  l0: number,
  l1: number,
  right: readonly string[],
  r0: number,
  r1: number,
  anchors: number[],
): void {
  if (l1 - l0 === 1) {
    const target = left[l0];
    for (let j = r0; j < r1; j++) {
      if (right[j] === target) {
        anchors.push(l0, j);
        return;
      }
    }
    return;
  }
  const target = right[r0];
  for (let i = l0; i < l1; i++) {
    if (left[i] === target) {
      anchors.push(i, r0);
      return;
    }
  }
}

function trimSliceAffixes(
  left: readonly string[],
  startL: number,
  endL: number,
  right: readonly string[],
  startR: number,
  endR: number,
  anchors: number[],
): { l0: number; l1: number; r0: number; r1: number; suffix: number } {
  let l0 = startL;
  let r0 = startR;
  while (l0 < endL && r0 < endR && left[l0] === right[r0]) {
    anchors.push(l0, r0);
    l0++;
    r0++;
  }
  let suffix = 0;
  while (l0 < endL - suffix && r0 < endR - suffix && left[endL - 1 - suffix] === right[endR - 1 - suffix]) {
    suffix++;
  }
  return { l0, l1: endL - suffix, r0, r1: endR - suffix, suffix };
}

function collectEqualAnchors(
  left: readonly string[],
  startL: number,
  endL: number,
  right: readonly string[],
  startR: number,
  endR: number,
  vf: Int32Array,
  vb: Int32Array,
  anchors: number[],
): void {
  const { l0, l1, r0, r1, suffix } = trimSliceAffixes(left, startL, endL, right, startR, endR, anchors);
  const n = l1 - l0;
  const m = r1 - r0;

  if (n === 1 || m === 1) {
    if (n > 0 && m > 0) matchSingleElement(left, l0, l1, right, r0, r1, anchors);
  } else if (n > 1 && m > 1) {
    const snake = findMiddleSnake(left, l0, l1, right, r0, r1, vf, vb);
    if (snake && snake.xStart + snake.yStart < n + m && n - snake.xEnd + (m - snake.yEnd) < n + m) {
      collectEqualAnchors(left, l0, l0 + snake.xStart, right, r0, r0 + snake.yStart, vf, vb, anchors);
      for (let s = 0; s < snake.xEnd - snake.xStart; s++) {
        anchors.push(l0 + snake.xStart + s, r0 + snake.yStart + s);
      }
      collectEqualAnchors(left, l0 + snake.xEnd, l1, right, r0 + snake.yEnd, r1, vf, vb, anchors);
    }
  }

  for (let s = 0; s < suffix; s++) {
    anchors.push(l1 + s, r1 + s);
  }
}

function filterSharedTokens(
  tokens: readonly string[],
  start: number,
  end: number,
  allowed: ReadonlySet<string>,
): { values: string[]; indices: Int32Array } {
  const values: string[] = [];
  const rawIndices: number[] = [];
  for (let i = start; i < end; i++) {
    const token = tokens[i] ?? '';
    if (allowed.has(token)) {
      values.push(token);
      rawIndices.push(i);
    }
  }
  return { values, indices: Int32Array.from(rawIndices) };
}

function appendGapOps(ops: EditOp[], curL: number, endL: number, curR: number, endR: number): void {
  for (let i = curL; i < endL; i++) {
    ops.push({ type: 'remove', oldIndex: i });
  }
  for (let j = curR; j < endR; j++) {
    ops.push({ type: 'add', newIndex: j });
  }
}

function diffInteriorRange(
  left: readonly string[],
  right: readonly string[],
  prefix: number,
  midL1: number,
  midR1: number,
  ops: EditOp[],
): void {
  if (prefix >= midL1 || prefix >= midR1) {
    appendGapOps(ops, prefix, midL1, prefix, midR1);
    return;
  }

  const rightVocab = new Set(right.slice(prefix, midR1));
  const subLeft = filterSharedTokens(left, prefix, midL1, rightVocab);
  if (subLeft.values.length === 0) {
    appendGapOps(ops, prefix, midL1, prefix, midR1);
    return;
  }

  const leftVocab = new Set(subLeft.values);
  const subRight = filterSharedTokens(right, prefix, midR1, leftVocab);
  const scratchLen = subLeft.values.length + subRight.values.length + 5;
  const vf = new Int32Array(scratchLen);
  const vb = new Int32Array(scratchLen);
  const subAnchors: number[] = [];

  collectEqualAnchors(
    subLeft.values,
    0,
    subLeft.values.length,
    subRight.values,
    0,
    subRight.values.length,
    vf,
    vb,
    subAnchors,
  );

  let curL = prefix;
  let curR = prefix;
  for (let k = 0; k < subAnchors.length; k += 2) {
    const origL = subLeft.indices[subAnchors[k] ?? 0] ?? curL;
    const origR = subRight.indices[subAnchors[k + 1] ?? 0] ?? curR;
    appendGapOps(ops, curL, origL, curR, origR);
    ops.push({ type: 'equal', oldIndex: origL, newIndex: origR });
    curL = origL + 1;
    curR = origR + 1;
  }
  appendGapOps(ops, curL, midL1, curR, midR1);
}

/** Linear-space Myers O(N+M)-memory shortest edit script with remove-before-add canonical order. */
function myersDiff(left: readonly string[], right: readonly string[]): EditOp[] {
  if (left.length === 0 && right.length === 0) return [];
  if (left.length === 0) return right.map((_, newIndex) => ({ type: 'add', newIndex }));
  if (right.length === 0) return left.map((_, oldIndex) => ({ type: 'remove', oldIndex }));

  const { prefix, suffix } = commonAffixLengths(left, right);
  const midL1 = left.length - suffix;
  const midR1 = right.length - suffix;
  const ops: EditOp[] = [];

  for (let p = 0; p < prefix; p++) {
    ops.push({ type: 'equal', oldIndex: p, newIndex: p });
  }
  diffInteriorRange(left, right, prefix, midL1, midR1, ops);
  for (let s = 0; s < suffix; s++) {
    ops.push({ type: 'equal', oldIndex: midL1 + s, newIndex: midR1 + s });
  }
  return ops;
}

function mergeSegments(segments: InlineDiffSegment[]): InlineDiffSegment[] {
  const merged: InlineDiffSegment[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const prev = merged.at(-1);
    if (prev && prev.type === seg.type) {
      prev.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

function commonAffixLengths(left: readonly string[], right: readonly string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

function appendMidSegments(
  midLeft: readonly string[],
  midRight: readonly string[],
  oldSegments: InlineDiffSegment[],
  newSegments: InlineDiffSegment[],
): number {
  if (midLeft.length + midRight.length > MAX_INLINE_CHAR_LEN) {
    if (midLeft.length > 0) oldSegments.push({ type: 'remove', text: midLeft.join('') });
    if (midRight.length > 0) newSegments.push({ type: 'add', text: midRight.join('') });
    return 0;
  }

  let equalChars = 0;
  for (const op of myersDiff(midLeft, midRight)) {
    if (op.type === 'equal') {
      const ch = midLeft[op.oldIndex] ?? '';
      oldSegments.push({ type: 'equal', text: ch });
      newSegments.push({ type: 'equal', text: ch });
      equalChars++;
    } else if (op.type === 'remove') {
      oldSegments.push({ type: 'remove', text: midLeft[op.oldIndex] ?? '' });
    } else {
      newSegments.push({ type: 'add', text: midRight[op.newIndex] ?? '' });
    }
  }
  return equalChars;
}

export function computeInlineDiffSegments(
  oldText: string,
  newText: string,
): { oldSegments: InlineDiffSegment[]; newSegments: InlineDiffSegment[]; similarity: number } | null {
  if (oldText === newText) return null;
  const left = [...oldText];
  const right = [...newText];
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return null;

  const { prefix, suffix } = commonAffixLengths(left, right);
  const oldSegments: InlineDiffSegment[] = [];
  const newSegments: InlineDiffSegment[] = [];

  if (prefix > 0) {
    const prefixText = left.slice(0, prefix).join('');
    oldSegments.push({ type: 'equal', text: prefixText });
    newSegments.push({ type: 'equal', text: prefixText });
  }

  const midEqual = appendMidSegments(
    left.slice(prefix, left.length - suffix),
    right.slice(prefix, right.length - suffix),
    oldSegments,
    newSegments,
  );

  if (suffix > 0) {
    const suffixText = left.slice(left.length - suffix).join('');
    oldSegments.push({ type: 'equal', text: suffixText });
    newSegments.push({ type: 'equal', text: suffixText });
  }

  const similarity = (prefix + suffix + midEqual) / maxLen;
  if (similarity < MIN_INLINE_SIMILARITY) return null;

  return {
    oldSegments: mergeSegments(oldSegments),
    newSegments: mergeSegments(newSegments),
    similarity,
  };
}

function findBestMatchingAdd(
  removeContent: string,
  lines: ProfileDiffLine[],
  nextAdd: number,
  addEnd: number,
): { index: number; match: NonNullable<ReturnType<typeof computeInlineDiffSegments>> } | null {
  let bestIdx = -1;
  let bestMatch: ReturnType<typeof computeInlineDiffSegments> = null;
  for (let a = nextAdd; a < addEnd; a++) {
    const addLine = lines[a];
    if (!addLine) continue;
    const candidate = computeInlineDiffSegments(removeContent, addLine.content);
    if (candidate && (!bestMatch || candidate.similarity > bestMatch.similarity)) {
      bestMatch = candidate;
      bestIdx = a;
    }
  }
  return bestMatch && bestIdx >= 0 ? { index: bestIdx, match: bestMatch } : null;
}

function pairChangeRun(
  lines: ProfileDiffLine[],
  removeStart: number,
  removeEnd: number,
  addStart: number,
  addEnd: number,
): void {
  const removeCount = removeEnd - removeStart;
  const addCount = addEnd - addStart;
  if (removeCount === 0 || addCount === 0 || removeCount > MAX_PAIRABLE_RUN || addCount > MAX_PAIRABLE_RUN) {
    return;
  }
  let nextAdd = addStart;
  for (let r = removeStart; r < removeEnd && nextAdd < addEnd; r++) {
    const removeLine = lines[r];
    if (!removeLine) continue;
    const best = findBestMatchingAdd(removeLine.content, lines, nextAdd, addEnd);
    const targetAdd = best ? lines[best.index] : undefined;
    if (best && targetAdd) {
      removeLine.segments = best.match.oldSegments;
      targetAdd.segments = best.match.newSegments;
      nextAdd = best.index + 1;
    }
  }
}

function attachIntraLineSegments(lines: ProfileDiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.type !== 'remove') {
      i++;
      continue;
    }
    const removeStart = i;
    while (i < lines.length && lines[i]?.type === 'remove') i++;
    const removeEnd = i;
    const addStart = i;
    while (i < lines.length && lines[i]?.type === 'add') i++;
    pairChangeRun(lines, removeStart, removeEnd, addStart, i);
  }
}

function formatUnifiedHunk(hunk: ProfileDiffHunk): string {
  const out = [`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`];
  for (const line of hunk.lines) {
    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
    out.push(`${prefix}${line.content}`);
    if (line.noNewlineAtEof) {
      out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n');
}

function toDiffLine(
  type: ProfileDiffLine['type'],
  rawLine: string,
  oldLine: number | null,
  newLine: number | null,
): ProfileDiffLine {
  const { content, noNewlineAtEof } = stripLineEnding(rawLine);
  return {
    type,
    content,
    oldLine,
    newLine,
    ...(noNewlineAtEof ? { noNewlineAtEof: true } : {}),
  };
}

function buildDiffLines(
  ops: EditOp[],
  beforeRaw: readonly string[],
  afterRaw: readonly string[],
): { allLines: ProfileDiffLine[]; addedLineCount: number; removedLineCount: number } {
  const allLines: ProfileDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let addedLineCount = 0;
  let removedLineCount = 0;

  for (const op of ops) {
    if (op.type === 'equal') {
      allLines.push(toDiffLine('context', beforeRaw[op.oldIndex] ?? '', oldLine++, newLine++));
    } else if (op.type === 'remove') {
      removedLineCount++;
      allLines.push(toDiffLine('remove', beforeRaw[op.oldIndex] ?? '', oldLine++, null));
    } else {
      addedLineCount++;
      allLines.push(toDiffLine('add', afterRaw[op.newIndex] ?? '', null, newLine++));
    }
  }

  return { allLines, addedLineCount, removedLineCount };
}

function collectChangeWindows(
  allLines: readonly ProfileDiffLine[],
  contextLines: number,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  for (let idx = 0; idx < allLines.length; idx++) {
    if (allLines[idx]?.type === 'context') continue;
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(allLines.length - 1, idx + contextLines);
    const prev = windows.at(-1);
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

function findPrecedingLineNumbers(
  allLines: readonly ProfileDiffLine[],
  beforeIdx: number,
): { prevOld: number; prevNew: number } {
  let prevOld = 0;
  let prevNew = 0;
  for (let k = beforeIdx; k >= 0 && (prevOld === 0 || prevNew === 0); k--) {
    const candidate = allLines[k];
    if (prevOld === 0 && candidate?.oldLine !== null && candidate?.oldLine !== undefined) {
      prevOld = candidate.oldLine;
    }
    if (prevNew === 0 && candidate?.newLine !== null && candidate?.newLine !== undefined) {
      prevNew = candidate.newLine;
    }
  }
  return { prevOld, prevNew };
}

function buildHunkFromWindow(allLines: readonly ProfileDiffLine[], start: number, end: number): ProfileDiffHunk {
  const lines = allLines.slice(start, end + 1).map((line) => ({ ...line }));
  attachIntraLineSegments(lines);
  const oldLines = lines.filter((line) => line.oldLine !== null);
  const newLines = lines.filter((line) => line.newLine !== null);
  const { prevOld, prevNew } = findPrecedingLineNumbers(allLines, start - 1);
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const oldStart = oldLines[0]?.oldLine ?? prevOld;
  const newStart = newLines[0]?.newLine ?? prevNew;
  return { oldStart, oldCount, newStart, newCount, lines };
}

export function computeProfileLineDiff(
  beforeContent: string,
  afterContent: string,
  options: { contextLines?: number } = {},
): ProfileLineDiff {
  const contextLines = Math.max(0, options.contextLines ?? 1);
  const beforeRaw = splitPhysicalLines(beforeContent);
  const afterRaw = splitPhysicalLines(afterContent);

  if (beforeContent === afterContent) {
    return {
      identical: true,
      initialWrite: false,
      addedLineCount: 0,
      removedLineCount: 0,
      beforeLineCount: beforeRaw.length,
      afterLineCount: afterRaw.length,
      hunks: [],
      unifiedDiff: '',
    };
  }

  const ops = myersDiff(beforeRaw, afterRaw);
  const { allLines, addedLineCount, removedLineCount } = buildDiffLines(ops, beforeRaw, afterRaw);
  const windows = collectChangeWindows(allLines, contextLines);
  const hunks = windows.map(({ start, end }) => buildHunkFromWindow(allLines, start, end));

  return {
    identical: false,
    initialWrite: beforeContent.length === 0 && afterContent.length > 0,
    addedLineCount,
    removedLineCount,
    beforeLineCount: beforeRaw.length,
    afterLineCount: afterRaw.length,
    hunks,
    unifiedDiff: hunks.map(formatUnifiedHunk).join('\n'),
  };
}
