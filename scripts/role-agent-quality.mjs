import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fixed before candidate runs. Only the selected seed and TASK.md enter the candidate workspace.
const samples = {
  'Q01-A': {
    task: '修复内存缓存。ttlMs 单位为毫秒；到期时刻及 ttlMs=0 均不可读；覆盖键后采用新期限。保留 false/null 等值。只改 src/cache.mjs，不加依赖。',
    allowed: ['src/cache.mjs'],
    files: {
      'src/cache.mjs': `export function createCache(now = Date.now) {
  const entries = new Map();
  return {
    put(key, value, ttlMs) { entries.set(key, { value, expiresAt: now() + ttlMs / 1000 }); },
    get(key) {
      const entry = entries.get(key);
      if (!entry || now() > entry.expiresAt) return undefined;
      return entry.value;
    },
  };
}
`,
      'test/public.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCache } from '../src/cache.mjs';
test('stores a fresh entry', () => {
  const cache = createCache(() => 0);
  cache.put('a', 'value', 1000);
  assert.equal(cache.get('a'), 'value');
});
`,
    },
    async check(root) {
      const { createCache } = await import(pathToFileURL(join(root, 'src/cache.mjs')).href);
      let clock = 10000;
      const cache = createCache(() => clock);
      cache.put('a', false, 1000);
      clock = 10999;
      assert.equal(cache.get('a'), false);
      clock = 11000;
      assert.equal(cache.get('a'), undefined);
      cache.put('zero', 'expired', 0);
      assert.equal(cache.get('zero'), undefined);
      cache.put('a', null, 500);
      assert.equal(cache.get('a'), null);
      clock = 11100;
      cache.put('a', 'replacement', 1000);
      clock = 11500;
      assert.equal(cache.get('a'), 'replacement');
      clock = 12100;
      assert.equal(cache.get('a'), undefined);
    },
  },
  'Q01-B': {
    task: '为便笺数据函数和展示函数增加 options.includeArchived。缺省/false 只返回活动便笺；true 包含已归档项，保持输入顺序、原内容和输入数组。展示层必须透传选项。只改 src/store.mjs 和 src/view.mjs，不加依赖。',
    allowed: ['src/store.mjs', 'src/view.mjs'],
    files: {
      'src/store.mjs': `export function listNotes(notes) { return notes.filter(note => !note.archived); }
`,
      'src/view.mjs': `import { listNotes } from './store.mjs';
export function renderNotes(notes) { return listNotes(notes).map(note => note.title).join('|'); }
`,
      'test/public.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderNotes } from '../src/view.mjs';
test('default list excludes archived notes', () => {
  assert.equal(renderNotes([{ title: 'old', archived: true }, { title: 'current' }]), 'current');
});
`,
    },
    async check(root) {
      const { listNotes } = await import(pathToFileURL(join(root, 'src/store.mjs')).href);
      const { renderNotes } = await import(pathToFileURL(join(root, 'src/view.mjs')).href);
      const notes = [{ title: 'a', archived: true }, { title: '' }, { title: 'b', archived: false }];
      const before = structuredClone(notes);
      assert.deepEqual(listNotes(notes), notes.slice(1));
      assert.deepEqual(listNotes(notes, { includeArchived: false }), notes.slice(1));
      assert.deepEqual(listNotes(notes, { includeArchived: true }), notes);
      assert.equal(renderNotes(notes), '|b');
      assert.equal(renderNotes(notes, {}), '|b');
      assert.equal(renderNotes(notes, { includeArchived: false }), '|b');
      assert.equal(renderNotes(notes, { includeArchived: true }), 'a||b');
      assert.deepEqual(listNotes([], { includeArchived: true }), []);
      assert.deepEqual(notes, before);
    },
  },
  'Q01-C': {
    task: '只改 src/money.mjs：parseMinorUnits 接收十进制金额字符串，允许首尾空白及一个 +/-，整数至少一位，小数只能一或两位。返回精确、安全整数分；无效语法或超出安全整数返回 null，不接受指数、Infinity 或多余小数。不得修改 receipt、测试或任何其他文件，不加依赖。',
    allowed: ['src/money.mjs'],
    files: {
      'src/money.mjs': `export function parseMinorUnits(text) { return Math.round(Number(text) * 100); }
`,
      'src/receipt.mjs': `import { parseMinorUnits } from './money.mjs';
export function receipt(text) { return { currency: 'CNY', minor: parseMinorUnits(text) }; }
`,
      'test/public.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receipt } from '../src/receipt.mjs';
test('receipt keeps currency and minor units', () => {
  assert.deepEqual(receipt('12.30'), { currency: 'CNY', minor: 1230 });
});
`,
    },
    async check(root) {
      const { parseMinorUnits } = await import(pathToFileURL(join(root, 'src/money.mjs')).href);
      const { receipt } = await import(pathToFileURL(join(root, 'src/receipt.mjs')).href);
      for (const [text, cents] of [
        ['0', 0],
        ['12.3', 1230],
        [' +00012.30 ', 1230],
        ['-1.01', -101],
        ['1.005', null],
        ['1e2', null],
        ['Infinity', null],
        ['', null],
        ['12.', null],
        ['.12', null],
        ['--1', null],
        ['not money', null],
        ['90071992547409.91', Number.MAX_SAFE_INTEGER],
        ['90071992547409.90', Number.MAX_SAFE_INTEGER - 1],
        ['90071992547409.89', Number.MAX_SAFE_INTEGER - 2],
        ['90071992547409.92', null],
        ['-90071992547409.91', Number.MIN_SAFE_INTEGER],
        ['-90071992547409.90', Number.MIN_SAFE_INTEGER + 1],
        ['-90071992547409.92', null],
      ])
        assert.equal(parseMinorUnits(text), cents, text);
      assert.deepEqual(receipt('-2.35'), { currency: 'CNY', minor: -235 });
    },
  },
};

const digest = (value) => createHash('sha256').update(value).digest('hex');
const [mode, id, workspaceArg, reportArg] = process.argv.slice(2);
const sample = samples[id];
if (!sample || !['prepare', 'verify'].includes(mode) || !workspaceArg || (mode === 'verify' && !reportArg)) {
  throw new Error(
    '用法：node scripts/role-agent-quality.mjs prepare Q01-A <新工作区> | verify Q01-A <工作区> <新报告.json>',
  );
}
const workspace = resolve(workspaceArg);
const reportPath = mode === 'verify' ? resolve(reportArg) : undefined;
if (reportPath) {
  const output = relative(workspace, reportPath);
  if (!isAbsolute(output) && output.split(sep)[0] !== '..') throw new Error('验收报告必须位于候选工作区之外。');
}
const files = {
  ...sample.files,
  'TASK.md': `${sample.task}\n\n验证入口：node --test test/public.test.mjs。最终说明改动、实际验证及限制。\n`,
  'package.json': `${JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/public.test.mjs' } }, null, 2)}\n`,
};
const baseline = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, digest(value)]));
if (mode === 'prepare') {
  if (existsSync(workspace)) throw new Error('工作区已存在；每轮必须使用独立的新目录，禁止覆盖。');
  mkdirSync(workspace, { recursive: true });
  Object.entries(files).forEach(([path, value]) => {
    const target = join(workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value, { flag: 'wx' });
  });
  process.stdout.write(
    `${JSON.stringify({ sample: id, workspace, scriptSha256: digest(readFileSync(new URL(import.meta.url))), baseline }, null, 2)}\n`,
  );
} else {
  const scan = (directory, prefix = '') =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '.git' && !prefix) return [];
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`样本工作区不接受符号链接：${relative}`);
      return entry.isDirectory() ? scan(join(directory, entry.name), relative) : [relative];
    });
  let fileHashes = {};
  let executionInputHashes = {};
  const snapshot = () =>
    Object.fromEntries(scan(workspace).map((path) => [path, digest(readFileSync(join(workspace, path)))]));
  const assertScope = (hashes) => {
    const paths = [...new Set([...Object.keys(baseline), ...Object.keys(hashes)])];
    const changed = paths.filter((path) => hashes[path] !== baseline[path]);
    assert.ok(
      changed.every((path) => sample.allowed.includes(path)),
      `超出允许范围：${changed.filter((path) => !sample.allowed.includes(path)).join(', ')}`,
    );
    return changed;
  };
  const [result] = await Promise.allSettled([
    Promise.resolve().then(async () => {
      executionInputHashes = snapshot();
      fileHashes = executionInputHashes;
      const changed = assertScope(executionInputHashes);
      const [checked] = await Promise.allSettled([sample.check(workspace)]);
      fileHashes = snapshot();
      assertScope(fileHashes);
      assert.deepEqual(fileHashes, executionInputHashes, '验收期间候选文件发生变化，不能为未核对字节签发通过。');
      if (checked.status === 'rejected') throw checked.reason;
      return changed;
    }),
  ]);
  const report = {
    sample: id,
    workspace,
    scriptSha256: digest(readFileSync(new URL(import.meta.url))),
    fileHashes,
    executionInputHashes,
    status: result.status === 'fulfilled' ? 'PASS' : 'FAIL',
    ...(result.status === 'fulfilled'
      ? { changed: result.value }
      : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }),
    claim: '仅该固定样本的行为及文件范围；不证明模型总体能力、审查质量或平台发行验收',
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${report.status} ${id} ${reportPath}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
