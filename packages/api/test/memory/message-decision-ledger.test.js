import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitMessageDecisionIndex } from '../../dist/domains/memory/message-decision-index.js';
import { parseDecisionLedger } from '../../dist/domains/memory/message-decision-ledger.js';

const accepted = '0001792080484605-000020-360a81d7';
const proposed = '0001791880484605-000021-360a81d8';
const replaced = '0001791080484605-000022-360a81d9';
const path = 'docs/features/F322-example.md';
const header = '### 已定（You 拍过）\n\n| 决定 | 时间（PDT） | 出处 | 谁做 |\n|---|---|---|---|\n';
const row = `| 标题最多两行 | 10-15 09:08 | 已定：\`thread_demo#${accepted}\`；提议 · 没采用：\`thread_demo#${proposed}\`；后来改了：\`thread_demo#${replaced}\` | 原作者 |\n`;

test('only exact table sources have declared roles; prose, draft sections and abbreviated coordinates remain unlabelled', () => {
  const text = `# Feature\n这里说已定：thread_demo#${accepted}\n## 待定\n${row}${header}${row}| 别的 | 10-15 | \`…${proposed}\`，起因 \`thread_else#${replaced}\` | 原作者 |\n## 下一节\n${row}`;
  const records = parseDecisionLedger(text, path, 'rev');
  assert.deepEqual(
    records.map((r) => [r.threadId, r.messageId, r.fact.status]),
    [
      ['thread_demo', accepted, 'decided'],
      ['thread_demo', proposed, 'not-adopted'],
      ['thread_demo', replaced, 'superseded'],
    ],
  );
  assert.equal(records[0].fact.conclusion, '标题最多两行');
  assert.equal(records[0].fact.decidedBy, undefined);
  assert.equal(records[0].fact.decidedAt, '10-15 09:08');
  assert.equal(parseDecisionLedger(text, 'docs/evidence/not-a-feature.md', 'rev').length, 0);
});

test('the actual F322 invitation row has no inferred decider or narrative date metadata', () => {
  // d529c2527986475c5a3e78ca763c7605dbea399b, canonical F322 table row 317.
  const actual = `| 猫想接下你顺口说的事时发的小卡（托付邀请），**不进待办**，留在原对话；F310「接下之前不进全局待办」原规则不改 | 10-15 宪宪按已给的建议定（10-14、10-15 两次问 You 未答，09:08 回「似曾相识」） | \`thread_mulzdwvps2dh01b3#${accepted}\`；逐类表第 108 行改为「不进待办」 | 原 B 不做这一类的待办卡；J3 计划末节的窄修订包作废 |\n`;
  const [record] = parseDecisionLedger(header + actual, path, 'rev');
  assert.equal(record.fact.status, 'decided');
  assert.ok(record.fact.conclusion.includes('不进待办'));
  assert.equal(record.fact.decidedBy, undefined);
  assert.equal(record.fact.decidedAt, undefined);
});

test('only explicit row decider and a complete date cell provide summary metadata', () => {
  const explicit = `### 已定（别人拍过）\n| 决定 | 日期 | 出处 | 决定人 |\n|---|---|---|---|\n| 最多两行 | 2026-10-15 09:08 PDT | \`thread_demo#${accepted}\` | 宪宪 |\n`;
  const [record] = parseDecisionLedger(explicit, path, 'rev');
  assert.equal(record.fact.decidedBy, '宪宪');
  assert.equal(record.fact.decidedAt, '2026-10-15 09:08 PDT');
  const [missing] = parseDecisionLedger(
    explicit.replace('2026-10-15 09:08 PDT', '10-14 提出、10-15 认可').replace('| 宪宪 |', '| |'),
    path,
    'rev',
  );
  assert.equal(missing.fact.decidedBy, undefined);
  assert.equal(missing.fact.decidedAt, undefined);
});

test('one source can record two distinct decisions without inventing a single combined conclusion', () => {
  const records = parseDecisionLedger(
    `${header}${row}| 托付邀请不进待办 | 10-15 | \`thread_demo#${accepted}\` | 原作者 |\n`,
    path,
    'rev',
  );
  assert.equal(records.filter((r) => r.messageId === accepted).length, 2);
  assert.equal(records.find((r) => r.fact.status === 'superseded').fact.historical, undefined);
});

test('a draft subheading does not inherit the decided table status', () => {
  const result = parseDecisionLedger(
    `${header}${row}#### 待讨论草稿\n| 决定 | 时间（PDT） | 出处 | 谁做 |\n|---|---|---|---|\n| 未决定 | 10-16 | \`thread_demo#0001792080484605-000099-360a81d7\` | 作者 |`,
    path,
    'rev',
  );
  assert.ok(result.every((record) => record.messageId !== '0001792080484605-000099-360a81d7'));
});

test('a fenced example table never declares a source status', () => {
  const result = parseDecisionLedger(`${header}\n\`\`\`md\n${row}\`\`\`\n`, path, 'rev');
  assert.deepEqual(result, []);
});

test('explicit bold roles bind the same-cell unique thread shorthand, while the cause is never a decision label', () => {
  const sources = `逐条出处：**已定** 10-08 You「认可」，\`thread_demo#${accepted}\`；起因 You「不喜欢」，\`…#${replaced}\`；**提议 · 没采用** 宪宪又问，\`…#${proposed}\`；**已定（再确认）** You，\`…#0001792080484605-000023-360a81d0\``;
  const records = parseDecisionLedger(`${header}| 最多两行 | 10-15 | ${sources} | 原作者 |\n`, path, 'rev');
  assert.deepEqual(
    records.map((r) => [r.messageId, r.fact.status]),
    [
      [accepted, 'decided'],
      [proposed, 'not-adopted'],
      ['0001792080484605-000023-360a81d0', 'decided'],
    ],
  );
  const ambiguous = sources.replace('起因 You', `\`thread_else#${replaced}\`；起因 You`);
  assert.ok(
    parseDecisionLedger(`${header}| 最多两行 | 10-15 | ${ambiguous} | 原作者 |\n`, path, 'rev').every(
      (r) => r.messageId !== proposed,
    ),
  );
});

test('Git-derived index pins an existing commit, matches both coordinate parts and ignores uncommitted edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-decision-index-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    await mkdir(join(root, 'docs/features'), { recursive: true });
    await writeFile(join(root, path), header + row);
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
    const index = new GitMessageDecisionIndex(root, 'HEAD');
    const a = await index.lookup([
      { threadId: 'thread_demo', messageId: accepted },
      { threadId: 'thread_other', messageId: proposed },
    ]);
    assert.equal(a.status, 'ready');
    assert.equal(a.facts.get(`thread_demo:${accepted}`)[0].conclusion, '标题最多两行');
    assert.equal(a.facts.has(`thread_other:${proposed}`), false);
    await writeFile(join(root, path), (header + row).replace('标题最多两行', 'UNCOMMITTED'));
    const b = await index.lookup([{ threadId: 'thread_demo', messageId: accepted }]);
    assert.equal(b.revision, a.revision);
    assert.ok(!JSON.stringify([...b.facts]).includes('UNCOMMITTED'));
    const expired = await index.lookup([{ threadId: 'thread_demo', messageId: accepted }], {
      deadlineAt: Date.now() - 1,
    });
    assert.equal(expired.status, 'unavailable');
    assert.equal(expired.facts.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
