import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { createMainHealthTemplate } from '../dist/infrastructure/scheduler/templates/main-health.js';

const exactReceipt = {
  availability: 'available',
  headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  treeSha: 'tree-b',
  receipt: { runId: 'run-green', terminalAt: 10 },
  lastGreen: { headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', runId: 'run-old' },
  bisectCandidates: ['commit-1', 'commit-2'],
};

function templateWith({ receipt = exactReceipt, check = { status: 'green', outputTail: 'check ok' } } = {}) {
  const inspectReceipt = mock.fn(async () => receipt);
  const inspectLocalTree = mock.fn(async () => ({
    headSha: exactReceipt.headSha,
    treeSha: exactReceipt.treeSha,
    clean: true,
  }));
  const runHealthCheck = mock.fn(async () => check);
  return {
    inspectReceipt,
    inspectLocalTree,
    runHealthCheck,
    template: createMainHealthTemplate({ inspectReceipt, inspectLocalTree, runHealthCheck, now: () => 1_000 }),
  };
}

function params(overrides = {}) {
  return {
    trigger: { type: 'cron', expression: '0 * * * *' },
    params: {
      repo: '/projects/example',
      branch: 'main',
      healthCommand: 'pnpm check',
      guardianCatId: 'codex-terra',
      triggerUserId: 'owner',
      ...overrides,
    },
    deliveryThreadId: 'thread-health',
  };
}

async function execute(template, overrides = {}) {
  const spec = template.createSpec('main-health-test', params(overrides));
  const admitted = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
  assert.equal(admitted.run, true);
  const deliver = mock.fn(async () => 'message-health');
  const trigger = mock.fn(async () => 'dispatched');
  await spec.run.execute(admitted.workItems[0].signal, admitted.workItems[0].subjectKey, {
    assignedCatId: 'fallback-health-monitor',
    deliver,
    invokeTrigger: { trigger },
  });
  return { spec, deliver, trigger };
}

describe('main-health schedule template', () => {
  it('requires an explicit repo, branch, cheap health command, guardian, and delivery thread', async () => {
    const { template } = templateWith();
    const valid = template.createSpec('valid', params());
    assert.equal((await valid.admission.gate({ taskId: 'valid', lastRunAt: null, tickCount: 1 })).run, true);

    for (const missing of ['repo', 'branch', 'healthCommand', 'guardianCatId']) {
      const invalid = template.createSpec(`missing-${missing}`, params({ [missing]: '' }));
      const result = await invalid.admission.gate({ taskId: invalid.id, lastRunAt: null, tickCount: 1 });
      assert.equal(result.run, false, missing);
    }
    const noThread = template.createSpec('no-thread', { ...params(), deliveryThreadId: null });
    assert.equal((await noThread.admission.gate({ taskId: noThread.id, lastRunAt: null, tickCount: 1 })).run, false);
  });

  it('accepts project-specific shell-free checks while rejecting full-gate and shell command surfaces', async () => {
    const { template } = templateWith();
    for (const healthCommand of [
      'pnpm check',
      'pnpm --filter @cat-cafe/api typecheck',
      'npm run health:ci',
      'cargo check --workspace',
      'go test ./...',
      'pytest -q',
      'tsc --noEmit',
      'eslint .',
      'vitest run',
      'biome check .',
      'prettier --check .',
      'ruff format --check .',
      'cargo fmt --check',
      'dotnet format --verify-no-changes',
      'make check',
      'just health',
    ]) {
      const projectCheck = template.createSpec(`project-check-${healthCommand}`, params({ healthCommand }));
      assert.equal(
        (await projectCheck.admission.gate({ taskId: projectCheck.id, lastRunAt: null, tickCount: 1 })).run,
        true,
        healthCommand,
      );
    }

    for (const healthCommand of [
      'pnpm gate',
      'pnpm --filter @cat-cafe/api test:gate',
      'sh -c pnpm-check',
      'pnpm exec bash -c ./harmless',
      'npm exec bash -c ./harmless',
      'pnpm dlx health-checker',
      'npx health-checker',
      'node scripts/pre-merge-check.sh',
      './scripts/pre-merge-check.sh',
      'env pnpm check',
      'pnpm run full-gate',
      'pnpm run health -- scripts/run-with-gate-resource-permit.mjs',
      'dash -c ./harmless',
      'ksh -c ./harmless',
      'nodejs ./harmless',
      'ash -c ./harmless',
      'custom-health-runner check',
      'npm health:ci',
      './pnpm check',
      '/tmp/pnpm check',
      './cargo check',
      '/usr/bin/pytest -q',
      'pnpm --dir /tmp/foreign check',
      'pnpm -C /tmp/foreign check',
      'pnpm --filter ../foreign check',
      'pytest --rootdir=/tmp/foreign -q',
      'cargo check --manifest-path /tmp/foreign/Cargo.toml',
      'vitest --root /tmp/foreign',
      'tsc --project /tmp/foreign/tsconfig.json',
      'go test ../foreign/...',
      'biome check /tmp/foreign',
      'eslint /tmp/foreign',
      'dotnet test ../foreign/foreign.csproj',
      'ruff check ../foreign',
      'ruff format .',
      'cargo fmt',
      'dotnet format',
      'biome format .',
      'tsc',
      'prettier .',
      'vitest',
      'make check./../../outside/foreign.o',
      'just check./../../outside/foreign.o',
    ]) {
      const unsafe = template.createSpec(`unsafe-${healthCommand}`, params({ healthCommand }));
      const result = await unsafe.admission.gate({ taskId: unsafe.id, lastRunAt: null, tickCount: 1 });
      assert.equal(result.run, false, healthCommand);
    }
  });

  it('rejects write-capable commands before execution and leaves the checkout unchanged', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'main-health-read-only-'));
    const sourcePath = path.join(repo, 'source.py');
    const original = 'items=[1,2]\n';
    writeFileSync(sourcePath, original);
    try {
      for (const healthCommand of ['ruff format .', 'cargo fmt', 'dotnet format', 'tsc']) {
        const runHealthCheck = mock.fn(async () => {
          writeFileSync(sourcePath, 'items = [1, 2]\n');
          return { status: 'green', outputTail: 'mutated' };
        });
        const template = createMainHealthTemplate({ runHealthCheck });
        const spec = template.createSpec(`write-capable-${healthCommand}`, params({ repo, healthCommand }));
        const admitted = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
        assert.deepEqual(
          [admitted.run, runHealthCheck.mock.calls.length, readFileSync(sourcePath, 'utf8')],
          [false, 0, original],
          healthCommand,
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports green only when pnpm check and an exact-tree receipt both cover branch HEAD', async () => {
    const { template, inspectReceipt, runHealthCheck } = templateWith();
    const { deliver, trigger } = await execute(template);

    assert.equal(inspectReceipt.mock.calls.length, 1);
    assert.deepEqual(inspectReceipt.mock.calls[0].arguments.slice(0, 2), ['/projects/example', 'main']);
    assert.equal(runHealthCheck.mock.calls[0].arguments[1], 'pnpm check');
    const content = deliver.mock.calls[0].arguments[0].content;
    assert.match(content, /status: green/i);
    assert.match(content, /run-green/);
    assert.doesNotMatch(content, /pnpm gate/i);
    assert.equal(trigger.mock.calls[0].arguments[1], 'codex-terra');
  });

  it('verifies the default local checkout projection against the receipt HEAD and tree', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'main-health-exact-tree-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'health@example.test'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Health Test'], { cwd: repo });
      writeFileSync(path.join(repo, 'health.txt'), 'green\n');
      execFileSync('git', ['add', 'health.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'health tree'], { cwd: repo });
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
      const inspectReceipt = mock.fn(async () => ({ ...exactReceipt, headSha, treeSha }));
      const runHealthCheck = mock.fn(async () => ({ status: 'green', outputTail: 'check ok' }));
      const template = createMainHealthTemplate({ inspectReceipt, runHealthCheck, now: () => 1_000 });

      const { deliver } = await execute(template, { repo });

      assert.equal(runHealthCheck.mock.calls.length, 1);
      assert.match(deliver.mock.calls[0].arguments[0].content, /status: green/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports unknown without running a check for staged, unstaged, or untracked checkout changes', async () => {
    const dirtyMutations = [
      (repo) => writeFileSync(path.join(repo, 'health.txt'), 'unstaged\n'),
      (repo) => {
        writeFileSync(path.join(repo, 'health.txt'), 'staged\n');
        execFileSync('git', ['add', 'health.txt'], { cwd: repo });
      },
      (repo) => writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n'),
    ];

    for (const makeDirty of dirtyMutations) {
      const repo = mkdtempSync(path.join(os.tmpdir(), 'main-health-dirty-tree-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'health@example.test'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Health Test'], { cwd: repo });
        writeFileSync(path.join(repo, 'health.txt'), 'green\n');
        execFileSync('git', ['add', 'health.txt'], { cwd: repo });
        execFileSync('git', ['commit', '-qm', 'health tree'], { cwd: repo });
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
        const treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
        makeDirty(repo);
        const inspectReceipt = mock.fn(async () => ({ ...exactReceipt, headSha, treeSha }));
        const runHealthCheck = mock.fn(async () => ({ status: 'green', outputTail: 'dirty check ok' }));
        const template = createMainHealthTemplate({ inspectReceipt, runHealthCheck, now: () => 1_000 });

        const { deliver } = await execute(template, { repo });

        assert.equal(runHealthCheck.mock.calls.length, 0);
        const content = deliver.mock.calls[0].arguments[0].content;
        assert.match(content, /status: unknown/i);
        assert.match(content, /check: pnpm check → not_run/i);
        assert.match(content, /local checkout.*dirty/i);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('reports unknown without running a check when the local checkout diverges from receipt HEAD or tree', async () => {
    for (const localTree of [
      { headSha: 'local-head', treeSha: exactReceipt.treeSha, clean: true },
      { headSha: exactReceipt.headSha, treeSha: 'local-tree', clean: true },
    ]) {
      const inspectReceipt = mock.fn(async () => exactReceipt);
      const inspectLocalTree = mock.fn(async () => localTree);
      const runHealthCheck = mock.fn(async () => ({ status: 'green', outputTail: 'stale check ok' }));
      const template = createMainHealthTemplate({ inspectReceipt, inspectLocalTree, runHealthCheck, now: () => 1_000 });

      const { deliver } = await execute(template);

      assert.equal(inspectLocalTree.mock.calls.length, 1);
      assert.equal(runHealthCheck.mock.calls.length, 0);
      const content = deliver.mock.calls[0].arguments[0].content;
      assert.match(content, /status: unknown/i);
      assert.match(content, /check: pnpm check → not_run/i);
      assert.match(content, /local checkout.*does not match.*branch HEAD/i);
    }
  });

  it('does not run an unanchored check when no receipt covers current HEAD', async () => {
    const { template, inspectLocalTree, runHealthCheck } = templateWith({
      receipt: { ...exactReceipt, availability: 'available', receipt: null },
      check: { status: 'red', outputTail: 'unanchored failure' },
    });
    const { deliver } = await execute(template);
    assert.equal(inspectLocalTree.mock.calls.length, 0);
    assert.equal(runHealthCheck.mock.calls.length, 0);
    const content = deliver.mock.calls[0].arguments[0].content;
    assert.match(content, /status: unknown/i);
    assert.match(content, /check: pnpm check → not_run/i);
    assert.match(content, /no exact-tree green receipt/i);
  });

  it('delivers red check truth, bounded bisect candidates, and a triage request without creating workflow state', async () => {
    const { template } = templateWith({ check: { status: 'red', outputTail: 'lint failed in packages/api' } });
    const { deliver, trigger } = await execute(template);
    const content = deliver.mock.calls[0].arguments[0].content;
    assert.match(content, /status: red/i);
    assert.match(content, /lint failed in packages\/api/);
    assert.match(content, /commit-1.*commit-2/s);
    assert.match(content, /triage/i);
    assert.equal(deliver.mock.calls.length, 1);
    assert.equal(trigger.mock.calls.length, 1);
  });

  it('warns open as degraded unknown when receipt automation is unavailable', async () => {
    const inspectReceipt = mock.fn(async () => {
      throw new Error('receipt reader unavailable');
    });
    const runHealthCheck = mock.fn(async () => ({ status: 'green', outputTail: 'check ok' }));
    const template = createMainHealthTemplate({ inspectReceipt, runHealthCheck, now: () => 1_000 });
    const { deliver, trigger } = await execute(template);
    const content = deliver.mock.calls[0].arguments[0].content;
    assert.equal(runHealthCheck.mock.calls.length, 0);
    assert.match(content, /status: unknown/i);
    assert.match(content, /check: pnpm check → not_run/i);
    assert.match(content, /degraded.*receipt reader unavailable/is);
    assert.equal(trigger.mock.calls.length, 1);
  });

  it('reports only an unexpired project quarantine supplied by the project-owned reader', async () => {
    const inspectReceipt = mock.fn(async () => exactReceipt);
    const runHealthCheck = mock.fn(async () => ({ status: 'green', outputTail: 'check ok' }));
    const activeReader = mock.fn(async (_repo, _file, now) =>
      now === 1_000 ? 'known flaky dependency (expires 1970-01-01T00:00:02.000Z)' : null,
    );
    const active = createMainHealthTemplate({
      inspectReceipt,
      runHealthCheck,
      readQuarantine: activeReader,
      now: () => 1_000,
    });
    const activeRun = await execute(active, { quarantineFile: '.health-quarantine.json' });
    assert.match(
      activeRun.deliver.mock.calls[0].arguments[0].content,
      /active project quarantine: known flaky dependency/,
    );

    const expired = createMainHealthTemplate({
      inspectReceipt,
      runHealthCheck,
      readQuarantine: async () => null,
      now: () => 3_000,
    });
    const expiredRun = await execute(expired, { quarantineFile: '.health-quarantine.json' });
    assert.doesNotMatch(expiredRun.deliver.mock.calls[0].arguments[0].content, /active project quarantine/);
  });
});
