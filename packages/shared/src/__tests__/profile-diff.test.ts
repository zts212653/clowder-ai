import { describe, expect, it } from 'vitest';
import { computeProfileLineDiff } from '../profile-diff.js';

describe('computeProfileLineDiff', () => {
  it('isolates changed hunks and intra-line character edits in a multi-section profile replacement', () => {
    const fillerA = Array.from({ length: 12 }, (_, i) => `- 既有约定 ${i + 1}：保持原样不变`).join('\n');
    const fillerMid = Array.from({ length: 12 }, (_, i) => `- 日常节奏 ${i + 1}：按上下文判断`).join('\n');
    const fillerB = Array.from({ length: 12 }, (_, i) => `- 协作事实 ${i + 1}：按证据说话`).join('\n');

    const before = [
      '# 共享事实',
      '',
      fillerA,
      '- 额度告急时先告知剩余比例，不要静默降档',
      fillerMid,
      '## 核心支柱',
      fillerB,
      '',
      '## 表达习惯',
      '- 复杂概念先用分层图解把限定条件讲得更清楚',
      '',
    ].join('\n');

    const after = [
      '# 共享事实',
      '',
      fillerA,
      '- 额度告急时先告知剩余比例，不要静默降档的',
      fillerMid,
      '## 核心支柱',
      '- 四支柱：everywhere / connect / grow / 主动（2026-07-03 原话）',
      fillerB,
      '',
      '## 表达习惯',
      '- 复杂概念先用分层图解把限定条件讲清楚更清楚',
      '',
    ].join('\n');

    const diff = computeProfileLineDiff(before, after, { contextLines: 1 });

    expect(diff.identical).toBe(false);
    expect(diff.initialWrite).toBe(false);
    expect(diff.removedLineCount).toBe(2);
    expect(diff.addedLineCount).toBe(3);
    expect(diff.hunks).toHaveLength(3);

    // Unchanged filler lines in the middle must not flood the diff output.
    expect(diff.unifiedDiff).not.toContain('既有约定 5');
    expect(diff.unifiedDiff).not.toContain('协作事实 10');

    // Hunk 1: accidental trailing "的" highlighted on the added line.
    const hunk1Add = diff.hunks[0]?.lines.find((line) => line.type === 'add');
    expect(hunk1Add?.segments).toEqual([
      { type: 'equal', text: '- 额度告急时先告知剩余比例，不要静默降档' },
      { type: 'add', text: '的' },
    ]);

    // Hunk 2: pure added bullet line.
    const hunk2Add = diff.hunks[1]?.lines.filter((line) => line.type === 'add');
    expect(hunk2Add).toHaveLength(1);
    expect(hunk2Add?.[0]?.content).toContain('四支柱：everywhere / connect / grow / 主动');

    // Hunk 3: "得" -> "清楚" highlighted inline.
    const hunk3Remove = diff.hunks[2]?.lines.find((line) => line.type === 'remove');
    const hunk3Add = diff.hunks[2]?.lines.find((line) => line.type === 'add');
    expect(hunk3Remove?.segments).toEqual([
      { type: 'equal', text: '- 复杂概念先用分层图解把限定条件讲' },
      { type: 'remove', text: '得' },
      { type: 'equal', text: '更清楚' },
    ]);
    expect(hunk3Add?.segments).toEqual([
      { type: 'equal', text: '- 复杂概念先用分层图解把限定条件讲' },
      { type: 'add', text: '清楚' },
      { type: 'equal', text: '更清楚' },
    ]);
  });

  it('marks initial writes from empty content without fabricating removed lines', () => {
    const diff = computeProfileLineDiff('', '# 关于你\n- 默认中文沟通\n');
    expect(diff.identical).toBe(false);
    expect(diff.initialWrite).toBe(true);
    expect(diff.removedLineCount).toBe(0);
    expect(diff.addedLineCount).toBe(2);
    expect(diff.unifiedDiff).toContain('@@ -0,0 +1,2 @@');
    expect(diff.unifiedDiff).toContain('+# 关于你');
    expect(diff.unifiedDiff).toContain('+- 默认中文沟通');
  });

  it('returns identical=true and empty hunks when content is byte-identical', () => {
    const diff = computeProfileLineDiff('同一份内容\n第二行\n', '同一份内容\n第二行\n');
    expect(diff.identical).toBe(true);
    expect(diff.addedLineCount).toBe(0);
    expect(diff.removedLineCount).toBe(0);
    expect(diff.hunks).toEqual([]);
    expect(diff.unifiedDiff).toBe('');
  });

  it('surfaces trailing-newline-only changes instead of reporting identical when byte hashes differ', () => {
    const diff = computeProfileLineDiff('第一行\n末尾无换行', '第一行\n末尾无换行\n');
    expect(diff.identical).toBe(false);
    expect(diff.removedLineCount).toBe(1);
    expect(diff.addedLineCount).toBe(1);
    expect(diff.unifiedDiff).toContain('\\ No newline at end of file');
  });

  it('preserves Astral Unicode code points without splitting surrogate pairs', () => {
    const diff = computeProfileLineDiff('签名：🐾旧版', '签名：🐾新版');
    const remove = diff.hunks[0]?.lines.find((line) => line.type === 'remove');
    const add = diff.hunks[0]?.lines.find((line) => line.type === 'add');
    expect(remove?.segments).toEqual([
      { type: 'equal', text: '签名：🐾' },
      { type: 'remove', text: '旧' },
      { type: 'equal', text: '版' },
    ]);
    expect(add?.segments).toEqual([
      { type: 'equal', text: '签名：🐾' },
      { type: 'add', text: '新' },
      { type: 'equal', text: '版' },
    ]);
  });

  it('keeps memory and runtime bounded on max-schema multi-short-line replacements while preserving all lines and EOF newline flags', () => {
    const before2048 = 'a\n'.repeat(2048);
    const after2048 = 'b\n'.repeat(2048);
    const abBefore = process.memoryUsage().arrayBuffers;
    const diff2048 = computeProfileLineDiff(before2048, after2048);
    const abDelta2048 = process.memoryUsage().arrayBuffers - abBefore;

    expect(diff2048.removedLineCount).toBe(2048);
    expect(diff2048.addedLineCount).toBe(2048);
    expect(abDelta2048).toBeLessThan(4 * 1024 * 1024);

    // 20,000-char schema boundary: 10,000 short lines replaced by 10,000 short lines with no trailing newline.
    const before10k = 'a\n'.repeat(10_000);
    const after10kNoEol = `${'b\n'.repeat(9_999)}b`;
    const startMs = performance.now();
    const diff10k = computeProfileLineDiff(before10k, after10kNoEol);
    const elapsedMs = performance.now() - startMs;

    expect(diff10k.removedLineCount).toBe(10_000);
    expect(diff10k.addedLineCount).toBe(10_000);
    expect(diff10k.hunks).toHaveLength(1);
    expect(diff10k.hunks[0]?.lines.at(-1)).toMatchObject({
      type: 'add',
      content: 'b',
      newLine: 10_000,
      noNewlineAtEof: true,
    });
    expect(diff10k.unifiedDiff).toContain('\\ No newline at end of file');
    expect(elapsedMs).toBeLessThan(1000);

    // Shared-vocabulary worst-case: 2,048 scrambled short lines over a small alphabet.
    let seed = 0x5f3759df;
    const nextRand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = ['alpha\n', 'beta\n', 'gamma\n', 'delta\n'];
    const scrambledBefore = Array.from({ length: 2048 }, () => alphabet[nextRand() >>> 30]).join('');
    const scrambledAfter = Array.from({ length: 2048 }, () => alphabet[nextRand() >>> 30]).join('');
    const abScrambledBefore = process.memoryUsage().arrayBuffers;
    const scrambledDiff = computeProfileLineDiff(scrambledBefore, scrambledAfter);
    const abScrambledDelta = process.memoryUsage().arrayBuffers - abScrambledBefore;

    expect(scrambledDiff.identical).toBe(false);
    expect(abScrambledDelta).toBeLessThan(4 * 1024 * 1024);
    expect(scrambledDiff.beforeLineCount).toBe(2048);
    expect(scrambledDiff.afterLineCount).toBe(2048);
  });

  it('reconstructs exact physical content and shortest edit counts across seeded random line inputs', () => {
    let seed = 123456789;
    const rand = (mod: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % mod;
    };
    const tokens = ['a', 'b', 'c', 'd', ''];

    const splitLines = (doc: string) => (doc === '' ? [] : (doc.match(/[^\n]*\n|[^\n]+/g) ?? []));

    const applyHunkLines = (
      lines: ReturnType<typeof computeProfileLineDiff>['hunks'][number]['lines'],
      src: string[],
      startCursor: number,
      out: string[],
    ): number => {
      let cursor = startCursor;
      for (const line of lines) {
        const raw = line.noNewlineAtEof ? line.content : `${line.content}\n`;
        if (line.type !== 'add') {
          expect(src[cursor]).toBe(raw);
          cursor++;
        }
        if (line.type !== 'remove') {
          out.push(raw);
        }
      }
      return cursor;
    };

    const applyHunks = (before: string, contextLines: number): string => {
      const diff = computeProfileLineDiff(before, currentAfter, { contextLines });
      if (diff.identical) return before;
      const src = splitLines(before);
      const out: string[] = [];
      let cursor = 0;
      for (const hunk of diff.hunks) {
        const hunkStartIdx = hunk.oldCount > 0 ? hunk.oldStart - 1 : hunk.oldStart;
        out.push(...src.slice(cursor, hunkStartIdx));
        cursor = applyHunkLines(hunk.lines, src, hunkStartIdx, out);
      }
      out.push(...src.slice(cursor));
      return out.join('');
    };

    const advanceLcsRow = (dp: Int32Array, ai: string, b: string[]) => {
      let prevDiag = 0;
      for (let j = 0; j < b.length; j++) {
        const up = dp[j + 1] ?? 0;
        const left = dp[j] ?? 0;
        dp[j + 1] = ai === b[j] ? prevDiag + 1 : Math.max(up, left);
        prevDiag = up;
      }
    };

    const exactLcsLen = (a: string[], b: string[]): number => {
      const dp = new Int32Array(b.length + 1);
      for (const ai of a) advanceLcsRow(dp, ai, b);
      return dp[b.length] ?? 0;
    };

    let currentAfter = '';
    for (let trial = 0; trial < 1000; trial++) {
      const lenA = rand(25);
      const lenB = rand(25);
      const makeDoc = (len: number) => {
        if (len === 0) return '';
        const lines = Array.from({ length: len }, () => tokens[rand(tokens.length)] ?? 'a');
        const body = lines.join('\n');
        return rand(2) === 0 ? `${body}\n` : body;
      };
      const before = makeDoc(lenA);
      currentAfter = makeDoc(lenB);
      const rawA = splitLines(before);
      const rawB = splitLines(currentAfter);
      const expectedMinEdits = rawA.length + rawB.length - 2 * exactLcsLen(rawA, rawB);
      const d0 = computeProfileLineDiff(before, currentAfter, { contextLines: 1 });
      expect(d0.addedLineCount + d0.removedLineCount).toBe(expectedMinEdits);
      for (const ctx of [0, 1, 2]) {
        expect(applyHunks(before, ctx)).toBe(currentAfter);
      }
    }
  });
});
