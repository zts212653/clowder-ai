import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-cwd-security-')));
  const workspace = join(root, 'work');
  const extra = join(root, '00-extra');
  const profile = join(root, 'profile');
  const protectedFile = join(profile, '.gemini/config/hooks.json');
  for (const path of [workspace, join(extra, 'child'), join(profile, '.gemini/config')])
    mkdirSync(path, { recursive: true });
  writeFileSync(protectedFile, '{"fixture":true}');
  symlinkSync(protectedFile, join(workspace, 'alias'));
  writeFileSync(join(extra, 'alias'), 'ordinary');
  symlinkSync(join(extra, 'child'), join(workspace, 'link'), 'dir');
  const options = { workspaceRoot: workspace, profileHome: profile, selfHost: () => ({ confidence: 'none' }) };
  const payload = (name, args) => ({ toolCall: { name, args }, workspacePaths: [extra, workspace] });
  const decide = (name, args, patch = {}) => decideAgyNativeHookPayload(payload(name, args), { ...options, ...patch });
  const env = { PATH: '/usr/bin:/bin', HOME: root, ZDOTDIR: root };
  return {
    root,
    workspace,
    extra,
    profile,
    protectedFile,
    options,
    payload,
    decide,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test(
  'explicit shell Cwd with symlink/.. cannot validate one alias then write another',
  { skip: !existsSync('/bin/zsh') },
  () => {
    const f = fixture();
    try {
      // Do not path.join these operands: it would erase the actual symlink/.. input.
      const Cwd = `${f.workspace}/link/..`;
      const command = 'printf changed > alias; pwd';
      const verdict = f.decide('run_command', { CommandLine: command, Cwd });
      assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
      const run = spawnSync('/bin/zsh', ['-c', verdict.overwrite?.CommandLine ?? command], {
        cwd: f.extra,
        env: f.env,
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(f.protectedFile, 'utf8'), '{"fixture":true}');
      assert.equal(readFileSync(join(f.extra, 'alias'), 'utf8'), 'changed');
      assert.equal(run.stdout.trim(), f.extra, 'execution uses the same physical directory as target validation');
    } finally {
      f.cleanup();
    }
  },
);

test('workflow explicit symlink/.. is frozen to the same physical Cwd without changing Script', () => {
  const f = fixture();
  try {
    const args = { Script: 'from __future__ import annotations\nprint("fixture")', Cwd: `${f.workspace}/link/..` };
    let projected;
    const verdict = f.decide('run_workflow', args, {
      onTargetDecision: (payload) => {
        projected = payload;
      },
    });
    assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
    assert.equal(projected.cwd, f.extra);
    assert.deepEqual(verdict.overwrite, { Cwd: f.extra });
    assert.equal(args.Script, 'from __future__ import annotations\nprint("fixture")');
  } finally {
    f.cleanup();
  }
});

test('a missing explicit command directory cannot acquire an auxiliary-directory fallback', () => {
  const f = fixture();
  try {
    for (const name of ['run_command', 'run_workflow']) {
      const args = name === 'run_command' ? { CommandLine: 'pwd' } : { Script: 'print("fixture")' };
      const verdict = f.decide(name, { ...args, Cwd: join(f.workspace, 'absent') });
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.overwrite, undefined);
    }
  } finally {
    f.cleanup();
  }
});

test(
  'input to a real persistent shell cannot be validated against an auxiliary workspace',
  { skip: !existsSync('/bin/zsh') },
  async () => {
    const f = fixture();
    let child;
    try {
      const start = 'printf "READY\\n"; exec /bin/bash --noprofile --norc';
      const launch = f.decide('run_command', { CommandLine: start });
      assert.equal(launch.decision, 'allow', JSON.stringify(launch));
      child = spawn('/bin/zsh', ['-c', launch.overwrite?.CommandLine ?? start], {
        cwd: f.extra,
        env: f.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        const [ready] = await once(child.stdout, 'data');
        assert.match(ready.toString(), /READY/);
        const Input = 'printf changed > alias\n';
        const verdict = f.decide('send_command_input', { CommandId: 'fixture-terminal', Input });
        child.stdin.end(`${verdict.decision === 'allow' ? Input : ''}exit 0\n`);
        await closed;
        assert.equal(readFileSync(f.protectedFile, 'utf8'), '{"fixture":true}');
        assert.equal(verdict.decision, 'deny');
        assert.match(verdict.reason, /directory|cwd/i);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
      }
    } finally {
      f.cleanup();
    }
  },
);

test('model-supplied terminal Cwd cannot certify where a persistent shell currently stands', () => {
  const f = fixture();
  try {
    for (const Input of ['pwd\n', 'printf changed > alias\n', '']) {
      const verdict = f.decide('send_command_input', { CommandId: 'unverified', Input, Cwd: f.extra });
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.overwrite, undefined);
    }
    // Existing non-Native callers do not silently acquire a new host binding.
    assert.deepEqual(
      decideAgyNativeHookPayload(f.payload('send_command_input', { Input: 'pwd\n' }), {
        selfHost: f.options.selfHost,
      }),
      { decision: 'allow' },
    );
  } finally {
    f.cleanup();
  }
});
