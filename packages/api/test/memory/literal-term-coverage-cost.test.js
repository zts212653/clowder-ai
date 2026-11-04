import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalTermCoverage } from '../../dist/domains/memory/literal-term-coverage.js';

test('distinct coverage preserves every term across the bounded native and automaton paths', () => {
  for (const size of [4, 5, 16, 17, 1000]) {
    const words = Array.from({ length: size }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const coverage = literalTermCoverage([...words, words[0], '']);
    assert.equal(coverage(''), 0);
    assert.equal(coverage(words.at(-1).repeat(3)), 1, 'a repeated last term counts exactly once');
    assert.equal(coverage(words.join('、')), size, 'algorithm selection never truncates query terms');
  }
  const words = ['甲', '甲乙', '乙', '猫🐾', '\ud83d', '\0乙'];
  for (const extra of [[], Array.from({ length: 20 }, (_, i) => `missing-${i}`)]) {
    const coverage = literalTermCoverage([...words, ...extra, '甲']);
    assert.equal(coverage('甲乙甲乙 猫🐾\0乙'), 6, 'overlaps, surrogate units and NUL retain includes semantics');
  }
  const syntax = literalTermCoverage(['[', '-', ']', '^', '\\', '\n', 'missing']);
  assert.equal(syntax('[-]^\\\n'), 6, 'query units remain data, including regex syntax and line breaks');
  assert.equal(syntax('absent'), 0);
  assert.equal(syntax('\n['), 2, 'a prior scan cannot leave a shared matcher past the next body');
});

test('six-term relevance coverage leaves CPU for retrieval and qualification', (t) => {
  // The natural global timeout scanned 273M UTF-16 units with six query terms.
  // Membership was already native; ranking still traversed every unit in JS.
  // This smaller neutral workload isolates that missed branch without SQLite,
  // production data, model calls or a wall-time assertion under host contention.
  const words = ['7316', '9248', '琴键', '旧事', '档案', '叙述'];
  const coverage = literalTermCoverage(words);
  const bodies = Array.from(
    { length: 64 },
    (_, i) => '中性文本甲乙丙丁'.repeat(128) + (i % 2 === 0 ? words.slice(0, -1).join('、') : words.at(-1)),
  );
  const before = process.cpuUsage();
  let total = 0;
  for (let i = 0; i < 131072; i++) total += coverage(bodies[i % bodies.length]);
  const cpu = process.cpuUsage(before);
  t.diagnostic(`131072 bodies / six distinct terms: ${JSON.stringify(cpu)} CPU microseconds`);
  assert.equal(total, 393216, 'all distinct terms count; repeated reads cannot retain prior matches');
  assert.ok(cpu.user + cpu.system < 1_000_000, `coverage CPU exceeded 1s: ${JSON.stringify(cpu)}`);
});

test('one short-term hit does not multiply scans for the other missing terms', (t) => {
  // The row has a real CJK hit and reaches relevance ranking. Checking each
  // remaining one-unit needle separately rescans the whole nonmatching tail.
  for (const size of [5, 6, 16]) {
    const words = Array.from({ length: size }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const coverage = literalTermCoverage(words);
    const body = words[0] + '中'.repeat(2048);
    const before = process.cpuUsage();
    let total = 0;
    for (let i = 0; i < 8192; i++) total += coverage(body);
    const cpu = process.cpuUsage(before);
    t.diagnostic(`8192 one-hit bodies / ${size} short terms: ${JSON.stringify(cpu)} CPU microseconds`);
    assert.equal(total, 8192);
    assert.ok(cpu.user + cpu.system < 1_000_000, `missing short-term CPU exceeded 1s: ${JSON.stringify(cpu)}`);
  }
});
