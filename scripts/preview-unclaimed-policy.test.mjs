import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { unclaimed } from './lib/preview-unclaimed-test-fixture.mjs';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';

test('native pre-call retains only canonical lifecycle coordinates after checkout release and finite retirement', async (t) => {
  const f = unclaimed(t);
  const old = process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
  process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = f.config.stateDir;
  t.after(() => {
    if (old === undefined) delete process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
    else process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = old;
  });
  renameSync(f.alphaRoot, `${f.alphaRoot}.released`);
  f.git(['worktree', 'prune']);
  const check = () => {
    for (const action of ['stop', 'status']) {
      const command = `pnpm --dir ${f.mainRoot} preview:process ${action} --cwd ${f.mainRoot} --port ${f.config.port} --json`;
      const decision = decideNativeHookPayload(
        { tool_name: 'exec_command', cwd: f.mainRoot, tool_input: { cmd: command } },
        { selfHost: () => ({ confidence: 'none' }) },
      );
      assert.equal(decision.decision, 'allow', JSON.stringify(decision));
      assert.equal(decision.target.value, `preview://alpha${f.mainRoot}:${f.config.port}`);
      assert.equal(decision.effect, action === 'status' ? 'read' : 'process_control');
    }
  };
  check();
  await stop(f);
  check();
  writeFileSync(join(`${f.record.completionPath}.settlement`, 'record.json'), '{}');
  const changed = decideNativeHookPayload(
    {
      tool_name: 'exec_command',
      cwd: f.mainRoot,
      tool_input: {
        cmd: `pnpm --dir ${f.mainRoot} preview:process stop --cwd ${f.mainRoot} --port ${f.config.port} --json`,
      },
    },
    { selfHost: () => ({ confidence: 'none' }) },
  );
  assert.notEqual(changed.target.value, `preview://alpha${f.mainRoot}:${f.config.port}`);
});

for (const problem of ['mixed completion', 'present owner', 'arbitrary child', 'protected tuple'])
  test(`released checkout policy does not attribute ${problem} to the old Alpha`, (t) => {
    const f = unclaimed(t),
      old = process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
    process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = f.config.stateDir;
    t.after(() => {
      if (old === undefined) delete process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
      else process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = old;
    });
    renameSync(f.alphaRoot, `${f.alphaRoot}.released`);
    f.git(['worktree', 'prune']);
    if (problem === 'mixed completion') f.write(f.record.completionPath, { ...f.completion, cleanupExitCode: 0 });
    if (problem === 'present owner') f.write(`${f.record.completionPath}.owner.json`, {});
    if (problem === 'arbitrary child')
      f.write(f.config.recordPath, { ...f.record, command: ['bash', '-c', 'echo unknown'] });
    if (problem === 'protected tuple')
      f.write(f.config.recordPath, {
        ...f.record,
        command: f.record.command.map((s) => (s === '5311,5312,5411,15397' ? '5311,5312,5411,6399' : s)),
      });
    const decision = decideNativeHookPayload(
      {
        tool_name: 'exec_command',
        cwd: f.mainRoot,
        tool_input: {
          cmd: `pnpm --dir ${f.mainRoot} preview:process stop --cwd ${f.mainRoot} --port ${f.config.port} --json`,
        },
      },
      { selfHost: () => ({ confidence: 'none' }) },
    );
    assert.notEqual(decision.target.value, `preview://alpha${f.mainRoot}:${f.config.port}`);
  });
