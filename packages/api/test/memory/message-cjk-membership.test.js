import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageLiteralRelevance } from '../../dist/domains/memory/message-literal-relevance.js';

test('Chinese membership preserves literal substring semantics for punctuation, overlaps and UTF-16', () => {
  const words = [
    '起名',
    '名',
    '猫🐾',
    '甲.*乙',
    '乙[丙',
    '丁\\戊',
    '戊|己',
    '庚(辛)',
    '壬$癸',
    '癸\0甲',
    '子+丑?寅^卯{2}辰]',
  ];
  const match = messageLiteralRelevance(words.join(' ')).matchesChineseFolded;
  for (const body of [
    '',
    'absent',
    'xx起名xx',
    '猫🐾',
    '甲anything乙',
    '甲.*乙',
    '乙[丙',
    '丁\\戊',
    '戊|己',
    '庚(辛)',
    '壬$癸',
    '癸\0甲',
    '\ud83d猫',
    '子+丑?寅^卯{2}辰]',
    '子丑寅卯卯辰',
  ]) {
    assert.equal(match(body), Number(words.some((word) => body.includes(word))), JSON.stringify(body));
    assert.equal(match(body), Number(words.some((word) => body.includes(word))), 'repeated reads must be stateless');
  }
  const maximum = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  const full = messageLiteralRelevance(maximum.join(' ')).matchesChineseFolded;
  assert.equal(full(maximum.at(-1)), 1, 'the final term of a legal 1999-character query is retained');
  assert.equal(full('absent'), 0);
  for (const width of [32, 33]) {
    const terms = ['甲', '乙', '丙', '丁', '戊'].map((last) => '中'.repeat(width - 1) + last);
    const selected = messageLiteralRelevance(terms.join(' ')).matchesChineseFolded;
    assert.equal(selected('中'.repeat(1024)), 0, 'a partial prefix is never a term hit');
    assert.equal(selected(terms.at(-1)), 1, 'algorithm selection cannot discard the last or long terms');
  }
});

test('broad CJK membership leaves CPU for ranking and qualification instead of counting every term', (t) => {
  // Natural failure visited 268M UTF-16 units with nine CJK terms. Isolate the
  // predicate at that volume; SQLite, body I/O and ranking have their own costs.
  // The 1s CPU bound leaves ample headroom over the measured native matcher and
  // fails the previous JS distinct-coverage traversal on the same input.
  const words = ['琴键', '旧事', '命名', '档案', '来源', '回忆', '叙述', '原文', '记录'];
  const match = messageLiteralRelevance(words.join(' ')).matchesChineseFolded;
  const bodies = Array.from({ length: 64 }, (_, i) => '中性文本甲乙丙丁'.repeat(128) + (i === 63 ? '记录' : i));
  const before = process.cpuUsage();
  let hits = 0;
  for (let i = 0; i < 262144; i++) hits += match(bodies[i % bodies.length]);
  const cpu = process.cpuUsage(before);
  t.diagnostic(`262144 bodies / 9 terms: ${JSON.stringify(cpu)} CPU microseconds`);
  assert.equal(hits, 4096, 'all matches, including the last query term, must survive');
  assert.ok(cpu.user + cpu.system < 1_000_000, `membership CPU exceeded 1s: ${JSON.stringify(cpu)}`);
});

test('few long shared-prefix terms keep bounded native substring CPU', (t) => {
  const prefix = '中'.repeat(664);
  const words = ['甲', '乙', '丙'].map((last) => prefix + last);
  const query = words.join(' ');
  assert.equal(query.length, 1997, 'the adversarial query is inside the existing legal limit');
  const match = messageLiteralRelevance(query).matchesChineseFolded;
  const body = '中'.repeat(1024);
  const before = process.cpuUsage();
  let hits = 0;
  for (let i = 0; i < 65536; i++) hits += match(body);
  const cpu = process.cpuUsage(before);
  t.diagnostic(`65536 bodies / 3 shared-prefix terms: ${JSON.stringify(cpu)} CPU microseconds`);
  assert.equal(hits, 0);
  assert.equal(match(words.at(-1)), 1, 'the final alternative remains a literal hit');
  assert.ok(cpu.user + cpu.system < 1_000_000, `shared-prefix CPU exceeded 1s: ${JSON.stringify(cpu)}`);
});
