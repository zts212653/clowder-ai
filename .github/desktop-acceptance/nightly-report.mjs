import assert from 'node:assert/strict';

const suites = ['smoke', 'full'];
const levels = ['L0', 'L1', 'L2', 'L3'];
const platforms = ['windows-x64', 'macos-arm64', 'macos-x64'];
const caseKey = ({ platform, id }) => `${platform}/${id}`;
const day = /^\d{4}-\d{2}-\d{2}$/;

export function selectCases(catalog, suite, selectedPlatforms) {
  assert.ok(suites.includes(suite), 'Invalid desktop suite');
  assert.ok(
    selectedPlatforms.length && selectedPlatforms.every((value) => platforms.includes(value)),
    'Invalid platforms',
  );
  assert.equal(new Set(selectedPlatforms).size, selectedPlatforms.length, 'Duplicate platform');
  assert.equal(new Set(catalog.map(({ id }) => id)).size, catalog.length, 'Duplicate case ID');
  for (const entry of catalog) {
    assert.match(entry.id, /^[A-Z][A-Z0-9-]+$/);
    assert.ok(entry.title && levels.includes(entry.level), `Invalid case ${entry.id}`);
    assert.ok(
      entry.platforms.length && entry.platforms.every((value) => platforms.includes(value)),
      `Invalid case platforms: ${entry.id}`,
    );
  }
  return selectedPlatforms.flatMap((platform) => {
    const selected = catalog
      .filter((entry) => entry.platforms.includes(platform) && (suite === 'full' || entry.level === 'L0'))
      .map((entry) => ({ ...entry, platform }));
    assert.ok(selected.length, `Empty ${suite} for ${platform}`);
    return selected;
  });
}

export function buildReport(catalog, run, receipts, exceptions = []) {
  assert.match(run.source, /^[a-f0-9]{40}$/);
  assert.match(run.catalogRevision, /^[a-f0-9]{40}$/);
  assert.match(run.date, day);
  const selected = selectCases(catalog, run.suite, run.platforms);
  const keys = new Set(selected.map(caseKey));
  const byCase = new Map();
  for (const receipt of receipts) {
    const key = caseKey(receipt);
    assert.ok(keys.has(key), `Unexpected receipt: ${key}`);
    assert.ok(!byCase.has(key), `Duplicate receipt: ${key}`);
    assert.ok(['passed', 'failed', 'blocked'].includes(receipt.status), `Invalid receipt: ${key}`);
    if (receipt.status !== 'blocked') assert.ok(receipt.evidence, `Missing evidence: ${key}`);
    if (receipt.status !== 'passed') assert.ok(receipt.code, `Missing reason: ${key}`);
    byCase.set(key, receipt);
  }

  const cases = selected.map((entry) => {
    const receipt = byCase.get(caseKey(entry)) ?? { status: 'blocked', code: 'missing-receipt' };
    const known =
      receipt.status === 'failed' &&
      exceptions.find(
        (exception) =>
          exception.id === entry.id &&
          exception.platform === entry.platform &&
          exception.code === receipt.code &&
          Number.isSafeInteger(exception.issue) &&
          exception.issue > 0 &&
          day.test(exception.expires) &&
          exception.expires >= run.date,
      );
    return {
      ...entry,
      code: receipt.code,
      evidence: receipt.evidence,
      rawStatus: receipt.status,
      status: known ? 'expected_failure' : receipt.status,
      knownIssue: known ? known.issue : undefined,
    };
  });
  const statuses = new Set(cases.map(({ status }) => status));
  let status = 'passed';
  if (statuses.has('failed')) status = 'failed';
  else if (statuses.has('blocked')) status = 'incomplete';
  else if (statuses.has('expected_failure')) status = 'known_failures';
  return { ...run, status, cases };
}

const cell = (value) =>
  String(value ?? '—')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/g, ' ');

export function renderReport(report) {
  const table = (cases) =>
    cases.length
      ? [
          '| 平台 | 用例 | 等级 | 结果 | 原因 | 证据 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...cases.map(
            (entry) =>
              `| ${[entry.platform, `${entry.id} ${entry.title}`, entry.level, entry.status, entry.knownIssue ? `${entry.code} (#${entry.knownIssue})` : entry.code, entry.evidence].map(cell).join(' | ')} |`,
          ),
        ].join('\n')
      : '无';
  const failures = report.cases.filter((entry) => entry.status === 'failed' || entry.status === 'expected_failure');

  return [
    `# 桌面安装包验证 · ${report.date} · ${report.suite}`,
    `结果 **${report.status}** · 待测提交 \`${report.source}\` · 用例版本 \`${report.catalogRevision}\``,
    report.runUrl ? `[运行与各平台证据](${report.runUrl})` : '',
    '## L0 新失败',
    table(report.cases.filter((entry) => entry.level === 'L0' && entry.status === 'failed')),
    '## L0 未完成',
    table(report.cases.filter((entry) => entry.level === 'L0' && entry.status === 'blocked')),
    '## 已知失败',
    table(report.cases.filter((entry) => entry.status === 'expected_failure')),
    '## 全部结果',
    table(report.cases),
    ...(failures.length
      ? [
          '## 失败明细',
          ...failures.map((entry) =>
            [
              `### ${entry.platform} · ${entry.id}`,
              `预期 ${entry.expected ?? '见用例目录'}`,
              `实际 ${entry.code}。证据位于 \`${entry.evidence}\`。`,
            ].join('\n\n'),
          ),
        ]
      : []),
    '',
  ].join('\n\n');
}
