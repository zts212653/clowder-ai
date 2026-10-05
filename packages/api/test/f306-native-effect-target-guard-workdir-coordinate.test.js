import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const guardModule = import('../../../scripts/native-effect-target-guard.mjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'f306-workdir-coordinate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, 'cat-cafe');
  const worktreeRoot = join(root, 'cat-cafe-f311-duck-evolution-demo');
  const otherWorktreeRoot = join(root, 'cat-cafe-f317-real-journey');
  const runtimeRoot = join(root, 'cat-cafe-runtime');
  const ordinaryRoot = join(root, 'ordinary-preview');
  for (const directory of [repoRoot, worktreeRoot, otherWorktreeRoot, runtimeRoot, ordinaryRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  return { root, repoRoot, worktreeRoot, otherWorktreeRoot, runtimeRoot, ordinaryRoot };
}

function worktreeChild(repoRoot, worktreeRoot) {
  return [
    'env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION',
    `CAT_CAFE_WORKSPACE_ROOT=${repoRoot}`,
    `CAT_CAFE_RUNTIME_ROOT=${worktreeRoot}`,
    'pnpm dev:direct',
  ].join(' ');
}

function assertUnbounded(decision, command) {
  assert.equal(decision.decision, 'deny', command);
  assert.equal(decision.reasonCode, 'unbounded_managed_preview_operation', command);
}

describe('F306 managed preview package coordinate', () => {
  test('uses an exact physical outer package coordinate when the hook only exposes the turn cwd', async (t) => {
    const { decideNativeHookPayload } = await guardModule;
    const { root, repoRoot, worktreeRoot, ordinaryRoot } = fixture(t);
    const decide = (command, cwd = repoRoot) =>
      decideNativeHookPayload(
        {
          turn_id: 'turn-workdir-coordinate',
          tool_name: 'exec_command',
          cwd,
          tool_input: { cmd: command },
        },
        { selfHost: () => ({ confidence: 'none' }) },
      );
    const prefix = `pnpm --dir ${worktreeRoot} preview:process`;
    const target = `preview://worktree${realpathSync(worktreeRoot)}:5188`;
    const child = worktreeChild(repoRoot, worktreeRoot);

    for (const { command, effect } of [
      {
        command: `${prefix} start --port 5188 --cwd ${worktreeRoot} --lifetime-seconds 14400 -- ${child}`,
        effect: 'service_mutation',
      },
      {
        command: `${prefix} status --port 5188 --cwd ${worktreeRoot} --json`,
        effect: 'read',
      },
      {
        command: `${prefix} stop --port 5188 --cwd ${worktreeRoot} --json`,
        effect: 'process_control',
      },
    ]) {
      const decision = decide(command);
      assert.equal(decision.decision, 'allow', command);
      assert.equal(decision.effect, effect, command);
      assert.equal(decision.target.kind, 'ordinary', command);
      assert.equal(decision.target.value, target, command);
    }

    const aliasRoot = join(root, 'aliases');
    const worktreeAlias = join(aliasRoot, 'cat-cafe-f311-alias');
    mkdirSync(aliasRoot, { recursive: true });
    symlinkSync(worktreeRoot, worktreeAlias, 'dir');
    const aliased = decide(
      `pnpm --dir ${worktreeAlias} preview:process status --port 5188 --cwd ${worktreeRoot} --json`,
    );
    assert.equal(aliased.decision, 'allow');
    assert.equal(aliased.effect, 'read');
    assert.equal(aliased.target.value, target);

    const legacySameCwd = decide(`pnpm preview:process status --port 5188 --cwd ${worktreeRoot} --json`, worktreeRoot);
    assert.equal(legacySameCwd.decision, 'allow');
    assert.equal(legacySameCwd.target.value, target);

    const ordinaryFallback = decide(
      `pnpm preview:process status --port 5188 --cwd ${ordinaryRoot} --json`,
      ordinaryRoot,
    );
    assert.equal(ordinaryFallback.decision, 'allow');
    assert.equal(ordinaryFallback.target.kind, 'ordinary');

    for (const command of [
      `pnpm preview:process start --port 5188 --cwd ${ordinaryRoot} -- npm run dev`,
      `pnpm preview:process status --port 5188 --cwd ${ordinaryRoot} --json`,
      `pnpm preview:process stop --port 5188 --cwd ${ordinaryRoot} --json`,
    ]) {
      const ordinaryFromRepository = decide(command);
      assert.equal(ordinaryFromRepository.decision, 'allow', command);
      assert.equal(ordinaryFromRepository.target.kind, 'ordinary', command);
    }

    const alpha = decide(`pnpm preview:process status --port 3011 --cwd ${repoRoot} --json`, repoRoot);
    assert.equal(alpha.decision, 'allow');
    assert.equal(alpha.target.value, `preview://alpha${realpathSync(repoRoot)}:3011`);
  });

  test('fails closed when package and target coordinates are absent, ambiguous, or unsafe', async (t) => {
    const { decideNativeHookPayload } = await guardModule;
    const { root, repoRoot, worktreeRoot, otherWorktreeRoot, runtimeRoot } = fixture(t);
    const decide = (command) =>
      decideNativeHookPayload(
        {
          turn_id: 'turn-workdir-coordinate-negative',
          tool_name: 'exec_command',
          cwd: repoRoot,
          tool_input: { cmd: command },
        },
        { selfHost: () => ({ confidence: 'none' }) },
      );
    const status = `preview:process status --port 5188 --cwd ${worktreeRoot} --json`;
    const missingDirectory = join(root, 'cat-cafe-missing');
    const nonDirectory = join(root, 'cat-cafe-file');
    const runtimeAlias = join(root, 'cat-cafe-fake-runtime');
    writeFileSync(nonDirectory, 'not a directory');
    symlinkSync(runtimeRoot, runtimeAlias, 'dir');
    const child = worktreeChild(repoRoot, worktreeRoot);

    for (const command of [
      `pnpm --dir preview:process status --port 5188 --cwd ${worktreeRoot} --json`,
      `pnpm --dir ${worktreeRoot} --dir ${worktreeRoot} ${status}`,
      `pnpm --dir ${worktreeRoot} preview:process status --port 5188 --cwd ${worktreeRoot} --cwd ${worktreeRoot} --json`,
      `pnpm --dir ${worktreeRoot} preview:process status --port 5188 --json`,
      `pnpm ${status}`,
      `pnpm --dir ${worktreeRoot} preview:process status --port 5188 --cwd ${otherWorktreeRoot} --json`,
      `pnpm --dir ${missingDirectory} ${status}`,
      `pnpm --dir ${nonDirectory} ${status}`,
      `pnpm --dir ${runtimeAlias} preview:process status --port 5188 --cwd ${runtimeAlias} --json`,
      `pnpm --dir / preview:process status --port 5188 --cwd / --json`,
      `pnpm --dir=/${worktreeRoot} ${status}`,
      `pnpm --silent --dir ${worktreeRoot} ${status}`,
      `pnpm -C ${worktreeRoot} ${status}`,
      `env pnpm --dir ${worktreeRoot} ${status}`,
      `command pnpm --dir ${worktreeRoot} ${status}`,
      `exec pnpm --dir ${worktreeRoot} ${status}`,
      `time pnpm --dir ${worktreeRoot} ${status}`,
      `corepack pnpm --dir ${worktreeRoot} ${status}`,
      `/tmp/evil/pnpm --dir ${worktreeRoot} ${status}`,
      `PNPM --dir ${worktreeRoot} ${status}`,
      'pnpm exec rg preview:process',
      'pnpm preview:process --help',
      `pnpm --dir ${worktreeRoot} preview:process start --port 5188 --cwd ${worktreeRoot} -- node child.js`,
      `pnpm --dir ${worktreeRoot} preview:process start --port 5188 --cwd ${worktreeRoot} -- ${child} extra`,
      `pnpm --dir ${repoRoot} preview:process status --port 3011 --cwd ${repoRoot} --json`,
    ]) {
      assertUnbounded(decide(command), command);
    }

    for (const reservedPort of ['3001', '3002', '3011', '3012', '4100', '4111', '6398', '6399']) {
      const command = `pnpm --dir ${worktreeRoot} preview:process status --port ${reservedPort} --cwd ${worktreeRoot} --json`;
      assertUnbounded(decide(command), command);
    }
  });

  test('selects status and stop grammar by target identity after an ordinary custom-child start', async (t) => {
    const { decideNativeHookPayload } = await guardModule;
    const { repoRoot, worktreeRoot } = fixture(t);
    const decide = (command) =>
      decideNativeHookPayload(
        {
          turn_id: 'turn-workdir-coordinate-custom-child',
          tool_name: 'exec_command',
          cwd: repoRoot,
          tool_input: { cmd: command },
        },
        { selfHost: () => ({ confidence: 'none' }) },
      );

    const customStart = `pnpm preview:process start --port 5188 --cwd ${worktreeRoot} -- env NODE_ENV=test node custom-preview.mjs`;
    const startDecision = decide(customStart);
    assert.equal(startDecision.decision, 'allow');
    assert.equal(startDecision.target.kind, 'ordinary');

    for (const { action, effect } of [
      { action: 'status', effect: 'read' },
      { action: 'stop', effect: 'process_control' },
    ]) {
      const bounded = `pnpm --dir ${worktreeRoot} preview:process ${action} --port 5188 --cwd ${worktreeRoot} --json`;
      const boundedDecision = decide(bounded);
      assert.equal(boundedDecision.decision, 'allow', bounded);
      assert.equal(boundedDecision.effect, effect, bounded);

      const ordinary = `pnpm preview:process ${action} --port 5188 --cwd ${worktreeRoot} --json`;
      assertUnbounded(decide(ordinary), ordinary);
    }
  });

  test('rejects shell metacharacters before resolving managed preview coordinates', async (t) => {
    const { decideNativeHookPayload } = await guardModule;
    const { root, repoRoot, runtimeRoot } = fixture(t);
    const sinkRoot = join(root, 'sink');
    mkdirSync(sinkRoot, { recursive: true });
    const coordinates = [
      `${runtimeRoot}>${join(sinkRoot, 'cat-cafe-redirection')}`,
      `${runtimeRoot}<${join(sinkRoot, 'cat-cafe-input')}`,
      `${runtimeRoot.slice(0, -1)}[e]`,
    ];
    for (const coordinate of coordinates) mkdirSync(coordinate, { recursive: true });

    for (const coordinate of coordinates) {
      const command = `pnpm --dir ${coordinate} preview:process stop --port 5188 --cwd ${coordinate} --json`;
      const decision = decideNativeHookPayload(
        {
          turn_id: 'turn-workdir-coordinate-metacharacter',
          tool_name: 'exec_command',
          cwd: repoRoot,
          tool_input: { cmd: command },
        },
        { selfHost: () => ({ confidence: 'none' }) },
      );
      assertUnbounded(decision, command);
    }
  });

  test('rejects composition around an otherwise canonical self-identifying preview command', async (t) => {
    const { decideNativeHookPayload } = await guardModule;
    const { repoRoot, worktreeRoot } = fixture(t);
    const canonical = `pnpm --dir ${worktreeRoot} preview:process status --port 5188 --cwd ${worktreeRoot} --json`;
    const decide = (command, cwd = repoRoot) =>
      decideNativeHookPayload(
        {
          turn_id: 'turn-workdir-coordinate-composition',
          tool_name: 'exec_command',
          cwd,
          tool_input: { cmd: command },
        },
        { selfHost: () => ({ confidence: 'none' }) },
      );

    for (const command of [
      `${canonical} && echo ok`,
      `${canonical} || echo failed`,
      `${canonical} | cat`,
      `${canonical}; pwd`,
      `${canonical}\nprintf done`,
    ]) {
      assertUnbounded(decide(command), command);
    }

    const legacyChain = `pnpm preview:process status --port 5188 --cwd ${worktreeRoot} --json && curl http://localhost:5188`;
    assertUnbounded(decide(legacyChain, worktreeRoot), legacyChain);
  });
});
