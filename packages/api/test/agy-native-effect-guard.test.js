import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const cwd = '/tmp/ordinary-workspace';
const options = { selfHost: () => ({ confidence: 'none' }) };
const payload = (name, args) => ({ toolCall: { name, args }, workspacePaths: [cwd] });

test('official ACP tokens, settings and trust decisions remain protected under the shared AGY policy', () => {
  const profileHome = '/tmp/acp-profile';
  for (const name of ['settings.json', 'acp_token.json', 'acp_business_token.json', 'trusted_workspaces.json']) {
    const path = join(profileHome, '.gemini/antigravity-acp', name);
    assert.equal(
      decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: path }), { ...options, profileHome }).decision,
      'deny',
      name,
    );
    assert.equal(
      decideAgyNativeHookPayload(payload('run_command', { CommandLine: `echo changed > ${path}` }), {
        ...options,
        profileHome,
      }).decision,
      'deny',
      name,
    );
  }
});

test('per-run data aliases keep native artifacts writable while control roots remain protected', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-artifact-alias-'));
  const profileHome = join(root, 'profile');
  const data = join(profileHome, '.gemini/antigravity-cli');
  const runGemini = join(profileHome, '.cat-cafe-native-runs/run-fixture/.gemini');
  mkdirSync(data, { recursive: true });
  mkdirSync(runGemini, { recursive: true });
  symlinkSync(data, join(runGemini, 'antigravity-cli'), 'dir');
  try {
    const artifact = join(runGemini, 'antigravity-cli/brain/conversation/task.md');
    assert.equal(
      decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: artifact }), { ...options, profileHome })
        .decision,
      'allow',
    );
    for (const target of [
      runGemini,
      join(runGemini, 'config/hooks.json'),
      join(runGemini, 'antigravity-cli/settings.json'),
      join(runGemini, 'antigravity-cli/antigravity-oauth-token'),
    ]) {
      assert.equal(
        decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: target }), { ...options, profileHome })
          .decision,
        'deny',
        target,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AGY effect decisions are the shared decisions for ordinary work and protected targets', () => {
  for (const command of [
    'node --test task.test.mjs',
    'redis-cli -p 6398 ping',
    'redis-cli -p 6399 flushall',
    'git push --force origin main',
    'rm -rf /tmp/cat-cafe-runtime',
  ]) {
    const shared = decideNativeHookPayload({ tool_name: 'Bash', tool_input: { command }, cwd }, options);
    const native = decideAgyNativeHookPayload(payload('run_command', { CommandLine: command, Cwd: cwd }), options);
    assert.equal(native.decision, shared.decision, command);
  }
  for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    for (const file of ['/tmp/project/package.json', '/tmp/project/.env', '/tmp/cat-cafe-runtime/server.ts']) {
      const shared = decideNativeHookPayload({ tool_name: 'Write', tool_input: { file_path: file }, cwd }, options);
      assert.equal(
        decideAgyNativeHookPayload(payload(name, { TargetFile: file }), options).decision,
        shared.decision,
        file,
      );
    }
  }
});

test('AGY executable customization aliases are protected while ordinary source is writable', () => {
  const root = mkdtempSync(join(tmpdir(), 'f325-guard-alias-'));
  try {
    mkdirSync(join(root, '.Agents'));
    symlinkSync(join(root, '.Agents'), join(root, 'alias'));
    for (const path of ['.Agents/hooks.json', '.Agents/MCP_CONFIG.JSON', 'alias/hooks.json']) {
      const result = decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: join(root, path) }), options);
      assert.equal(result.decision, 'deny', path);
    }
    assert.equal(
      decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: join(root, 'ordinary.ts') }), options).decision,
      'allow',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only invocations keep existing native and MCP restrictions', () => {
  for (const name of ['write_to_file', 'run_command', 'call_mcp_tool', 'invoke_subagent']) {
    assert.equal(decideAgyNativeHookPayload(payload(name, {}), { ...options, readOnly: true }).decision, 'deny');
  }
  assert.equal(
    decideAgyNativeHookPayload(payload('view_file', { AbsolutePath: '/tmp/source.ts' }), { ...options, readOnly: true })
      .decision,
    'allow',
  );
});

test('the official CLI settings and mounted skill view are host control data, including symlink targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-profile-control-'));
  try {
    const profileHome = join(root, 'profile');
    const source = join(root, 'source');
    mkdirSync(join(profileHome, '.gemini/antigravity-cli'), { recursive: true });
    mkdirSync(source);
    symlinkSync(source, join(profileHome, '.gemini/antigravity-cli/skills'));
    for (const name of [
      'settings.json',
      'skills/fixture/SKILL.md',
      '.cat-cafe-skills-abc/fixture',
      'plugins/tool/index.js',
    ]) {
      const path = join(profileHome, '.gemini/antigravity-cli', name);
      assert.equal(
        decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: path }), { ...options, profileHome })
          .decision,
        'deny',
        path,
      );
    }
    const command = `echo overwrite > ${profileHome}/.gemini/antigravity-cli/settings.json`;
    assert.equal(
      decideAgyNativeHookPayload(payload('run_command', { CommandLine: command }), { ...options, profileHome })
        .decision,
      'deny',
    );
    const artifact = join(profileHome, '.gemini/antigravity/brain/task.md');
    assert.equal(
      decideAgyNativeHookPayload(payload('write_to_file', { TargetFile: artifact }), { ...options, profileHome })
        .decision,
      'allow',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bad hook input always prints a concrete deny instead of AGY empty-output allow', () => {
  const script = new URL('../../../scripts/agy-native-effect-guard.mjs', import.meta.url);
  for (const input of ['not json', '{}', '{"toolCall":{"name":"run_command","args":{}}}']) {
    const stdout = execFileSync(process.execPath, [script.pathname], { input, encoding: 'utf8' });
    assert.equal(JSON.parse(stdout).decision, 'deny');
  }
});

test('AGY control targets follow shell directories, normalized paths and quoted words', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-control-command-'));
  const profileHome = join(root, 'profile');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
  try {
    for (const command of [
      "cd .agents && printf '{}' > hooks.json",
      'pushd .agents >/dev/null && printf x > hooks.json',
      'cd .agents >/dev/null && printf x > hooks.json',
      '(pushd .agents >/dev/null && printf x > hooks.json)',
      '(cd .agents >/dev/null && printf x > hooks.json)',
      "printf '{}' > .agents/./hooks.json",
      "printf '{}' > .agents//hooks.json",
      "printf '{}' > .agents/'hooks'.json",
      "cd ~/.gemini/config && printf '{}' > mcp_config.json",
      'cd .agents && tee hooks.json < /dev/null',
      'cd .agents && rm -f hooks.json',
      'target=.agents/hooks.json; printf payload > "$target"',
      'cd "$HOME/.gemini/config" && printf payload > hooks.json',
      "sh -c 'cd .agents && printf x > hooks.json'",
      'sed -i x .agents/hooks.json',
      'cp notes.txt .agents/hooks.json',
      'cp -t .agents/plugins notes.txt',
      'cp -at.agents/plugins notes.txt',
      'cp --target-dir=.agents/plugins notes.txt',
      'install --target-directory=.agents/plugins notes.txt',
      'ln .agents/hooks.json ordinary-alias.json',
      'dd if=notes.txt of=.agents/hooks.json',
      'target=.agents/hooks.json; dd if=notes.txt of="$target"',
      'cd .agents && dd if=../notes.txt of=hooks.json',
      "printf 'cd .agents && printf x > hooks.json' | sh",
      'rm -rf .agents',
      `rm -rf ${profileHome}/.gemini`,
      `printf x > ${profileHome}/.cat-cafe-native-turn.sqlite`,
      `rm -rf ${profileHome}/.cat-cafe-native-runs`,
      `printf x > ${profileHome}/.cat-cafe-native-runs/run-other/.gemini/config/hooks.json`,
    ]) {
      assert.equal(
        decideAgyNativeHookPayload(payload('run_command', { CommandLine: command, Cwd: root }), {
          ...options,
          profileHome,
        }).decision,
        'deny',
        command,
      );
    }
    for (const command of [
      "printf '.agents/hooks.json' > notes.txt",
      'cd .agents && cat hooks.json',
      'pushd .agents >/dev/null && cat hooks.json',
      '(pushd .agents >/dev/null && cat hooks.json)',
      'cd .agents >/dev/null && cat hooks.json',
      'cp .agents/hooks.json notes.txt',
      'dd if=.agents/hooks.json of=notes.txt',
      'node --test',
    ]) {
      assert.equal(
        decideAgyNativeHookPayload(payload('run_command', { CommandLine: command, Cwd: root }), {
          ...options,
          profileHome,
        }).decision,
        'allow',
        command,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
