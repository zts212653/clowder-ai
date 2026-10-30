import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { materializeAgyNativeEffectGuard } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-effect-guard.js';

const noPosixShell = !existsSync('/bin/zsh');

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-command-cwd-')));
  const workspace = join(root, "project ' $(touch injected) 中");
  const extra = join(root, '00-extra');
  const profile = join(root, 'profile');
  for (const path of [workspace, extra, join(profile, '.gemini/config')]) mkdirSync(path, { recursive: true });
  const options = { workspaceRoot: workspace, profileHome: profile, selfHost: () => ({ confidence: 'none' }) };
  const payload = (name, args) => ({ toolCall: { name, args }, workspacePaths: [extra, workspace] });
  const decide = (name, args, patch = {}) => decideAgyNativeHookPayload(payload(name, args), { ...options, ...patch });
  const run = (command, args = {}) => {
    const verdict = decide('run_command', { CommandLine: command, ...args });
    assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
    return spawnSync('/bin/zsh', ['-c', verdict.overwrite?.CommandLine ?? command], {
      cwd: extra,
      env: { PATH: '/usr/bin:/bin', HOME: root, ZDOTDIR: root },
      encoding: 'utf8',
      timeout: 3000,
    });
  };
  return {
    root,
    workspace,
    extra,
    profile,
    options,
    payload,
    decide,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const command of ['pwd', "cat <<'EOF'\nhello\nEOF\npwd # trailing comment"]) {
  test(
    `command default ignores the earlier auxiliary workspace: ${command.split('\n')[0]}`,
    { skip: noPosixShell },
    () => {
      const f = fixture();
      try {
        const result = f.run(command);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim().split('\n').at(-1), f.workspace);
        assert.equal(existsSync(join(f.extra, 'injected')), false, 'the directory name is literal shell data');
      } finally {
        f.cleanup();
      }
    },
  );
}

test(
  'an explicit command cd remains relative to the project and its exit status is preserved',
  { skip: noPosixShell },
  () => {
    const f = fixture();
    try {
      mkdirSync(join(f.workspace, 'sub'));
      const result = f.run('cd sub && pwd; exit 19');
      assert.equal(result.status, 19);
      assert.equal(result.stdout.trim(), join(f.workspace, 'sub'));
    } finally {
      f.cleanup();
    }
  },
);

test('an explicit legacy Cwd is executed and validated at that directory', { skip: noPosixShell }, () => {
  const f = fixture();
  try {
    const directory = join(f.workspace, 'chosen');
    mkdirSync(directory);
    const result = f.run('pwd', { Cwd: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), directory);
  } finally {
    f.cleanup();
  }
});

test('relative target checks use the pinned cwd before allowing a rewritten command', () => {
  const f = fixture();
  const protectedFile = join(f.profile, '.gemini/config/hooks.json');
  writeFileSync(protectedFile, '{}');
  symlinkSync(protectedFile, join(f.workspace, 'alias'));
  writeFileSync(join(f.extra, 'alias'), 'ordinary');
  try {
    const verdict = f.decide('run_command', { CommandLine: 'printf changed > alias' });
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.overwrite, undefined, 'a denial must never carry executable replacement arguments');
    assert.equal(readFileSync(protectedFile, 'utf8'), '{}');
  } finally {
    f.cleanup();
  }
});

test('read-only still denies commands; unrelated tools and legacy callers are not rewritten', () => {
  const f = fixture();
  try {
    const denied = f.decide('run_command', { CommandLine: 'pwd' }, { readOnly: true });
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.overwrite, undefined);
    const args = { AbsolutePath: join(f.workspace, 'source.ts') };
    assert.deepEqual(f.decide('view_file', args), { decision: 'allow' });
    assert.deepEqual(args, { AbsolutePath: join(f.workspace, 'source.ts') });
    assert.deepEqual(
      decideAgyNativeHookPayload(f.payload('run_command', { CommandLine: 'pwd' }), {
        selfHost: f.options.selfHost,
      }),
      { decision: 'allow' },
    );
  } finally {
    f.cleanup();
  }
});

test('Python workflows receive their supported Cwd argument without rewriting script bytes', () => {
  const f = fixture();
  try {
    const Script = 'from __future__ import annotations\nprint("fixture")';
    const args = { Script };
    const verdict = f.decide('run_workflow', args);
    assert.equal(verdict.decision, 'allow');
    assert.deepEqual(verdict.overwrite, { Cwd: f.workspace });
    assert.deepEqual(args, { Script });
  } finally {
    f.cleanup();
  }
});

test('malformed explicit cwd cannot make workflow execution differ from guard validation', () => {
  const f = fixture();
  try {
    for (const Cwd of [null, 7, {}, 'relative/path']) {
      const verdict = f.decide('run_workflow', { Script: 'print("fixture")', Cwd });
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.overwrite, undefined);
    }
  } finally {
    f.cleanup();
  }
});

test(
  'a directory removed after validation cannot run a command in the auxiliary directory',
  { skip: noPosixShell },
  () => {
    const f = fixture();
    try {
      const command = 'printf leaked > marker';
      const verdict = f.decide('run_command', { CommandLine: command });
      assert.equal(verdict.decision, 'allow');
      rmSync(f.workspace, { recursive: true });
      const result = spawnSync('/bin/zsh', ['-c', verdict.overwrite?.CommandLine ?? command], {
        cwd: f.extra,
        env: { PATH: '/usr/bin:/bin', HOME: f.root, ZDOTDIR: f.root },
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(f.extra, 'marker')), false);
    } finally {
      f.cleanup();
    }
  },
);

test('Native freezes the task workspace in its host-owned hook command', () => {
  const f = fixture();
  try {
    const path = materializeAgyNativeEffectGuard({
      profileHome: f.profile,
      accountHome: f.profile,
      runtimeRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      workspaceRoot: f.workspace,
      readOnly: false,
    });
    const command = JSON.parse(readFileSync(path, 'utf8'))['cat-cafe-native-effect'].PreToolUse[0].hooks[0].command;
    const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
    assert.ok(command.endsWith(quote(f.workspace)), 'workspace comes from the launch policy, not model arguments');
  } finally {
    f.cleanup();
  }
});

test(
  'ordinary Service launch runs the packaged hook at the project while its process stays isolated',
  { skip: noPosixShell },
  async () => {
    const f = fixture();
    const service = new AgyNativeAgentService({
      catId: 'gemini38',
      command: '/usr/bin/true',
      profile: {
        enabled: true,
        profileId: 'gemini38',
        homeRoot: join(f.root, 'accounts'),
        model: 'gemini-3.8-flash-high',
        trustedWorkspaces: [f.workspace],
      },
      l0CompilerFn: async () => '# Identity\nSynthetic cwd integration.\n',
    });
    let observed;
    try {
      const messages = [];
      for await (const message of service.invoke('Check the current project.', {
        workingDirectory: f.workspace,
        spawnCliOverride: async function* (launch) {
          const config = launch.args.find((arg) => arg.startsWith('--gemini_dir=')).slice('--gemini_dir='.length);
          const hook = JSON.parse(readFileSync(join(config, 'config/hooks.json'), 'utf8'))['cat-cafe-native-effect']
            .PreToolUse[0].hooks[0].command;
          const verdict = JSON.parse(
            execFileSync('/bin/sh', ['-c', hook], {
              input: JSON.stringify(f.payload('run_command', { CommandLine: 'pwd' })),
              encoding: 'utf8',
              timeout: 5000,
            }),
          );
          assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
          const result = spawnSync('/bin/zsh', ['-c', verdict.overwrite?.CommandLine ?? 'pwd'], {
            cwd: f.extra,
            env: { PATH: '/usr/bin:/bin', HOME: f.root, ZDOTDIR: f.root },
            encoding: 'utf8',
            timeout: 3000,
          });
          observed = {
            cwd: launch.cwd,
            actual: result.stdout.trim(),
            config,
            home: launch.env.HOME,
            status: result.status,
          };
          yield {
            event: 'init',
            conversation_id: 'cwd-integration',
            init: {
              agent: launch.args[launch.args.indexOf('--agent') + 1],
              cwd: launch.cwd,
              model: 'gemini-3.8-flash-high',
              permission_mode: 'request-review',
              tools: [],
            },
          };
          yield {
            event: 'result',
            result: { conversation_id: 'cwd-integration', status: 'SUCCESS', response: 'Done.', num_turns: 1 },
          };
        },
      }))
        messages.push(message);
      assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
      assert.equal(observed.status, 0);
      assert.equal(observed.actual, f.workspace);
      assert.notEqual(observed.cwd, f.workspace, 'carrier cache/history sandbox is preserved');
      assert.ok(observed.cwd.startsWith(observed.home));
      assert.equal(existsSync(observed.config), false, 'run configuration is removed before done');
      assert.equal(existsSync(join(observed.home, '.gemini/antigravity-cli')), true);
    } finally {
      f.cleanup();
    }
  },
);
