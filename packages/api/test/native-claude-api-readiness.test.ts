import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeRuntimeReadiness } from '../src/routes/native-runtime-readiness.js';

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
  for (const source of ['settings', 'process']) {
    test(`Claude ${key} in ${source} is configured without launching a potentially mutating login probe`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'native-api-readiness-'));
      const names = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
      const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      const file = join(root, 'settings.json');
      const settings = JSON.stringify({
        model: 'opus',
        env: source === 'settings' ? { [key]: 'fake-readiness-only' } : {},
      });
      writeFileSync(file, settings);
      try {
        process.env.CLAUDE_CONFIG_DIR = root;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        if (source === 'process') process.env[key] = 'fake-readiness-only';
        // No executable exists: this would return unknown if it tried auth status.
        const result = await nativeRuntimeReadiness(
          { id: 'claude', installed: true, command: join(root, 'must-not-run') },
          root,
          true,
        );
        assert.equal(result.status, 'configured');
        assert.equal(readFileSync(file, 'utf8'), settings);
        assert.equal(JSON.stringify(result).includes('fake-readiness-only'), false);
        const missing = await nativeRuntimeReadiness({ id: 'claude', installed: false }, root, true);
        assert.equal(missing.status, 'not_installed');
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('malformed configuration and blank API credentials cannot establish authentication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-api-empty-'));
  const names = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    process.env.ANTHROPIC_API_KEY = ' ';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    for (const contents of ['invalid json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: ' ' } })]) {
      writeFileSync(join(root, 'settings.json'), contents);
      const result = await nativeRuntimeReadiness(
        { id: 'claude', installed: true, command: join(root, 'absent') },
        root,
        true,
      );
      assert.equal(result.status, 'unknown');
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude credentials follow the actual project/local settings scope without copying or changing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-api-scopes-'));
  const user = join(root, 'user');
  const project = join(root, 'project');
  const names = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  mkdirSync(user);
  mkdirSync(join(project, '.claude'), { recursive: true });
  const files = [
    join(user, 'settings.json'),
    join(project, '.claude/settings.json'),
    join(project, '.claude/settings.local.json'),
  ];
  try {
    process.env.CLAUDE_CONFIG_DIR = user;
    for (const name of names.slice(1)) delete process.env[name];
    const target = { id: 'claude', installed: true, command: join(root, 'must-not-run') };
    for (const scope of [1, 2]) {
      for (const file of files) writeFileSync(file, '{}');
      writeFileSync(files[scope], JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'private-scope-token' } }));
      const before = files.map((file) => readFileSync(file, 'utf8'));
      const result = await nativeRuntimeReadiness(target, project, true);
      assert.equal(result.status, 'configured', `scope ${scope} is consumed by the same native launch`);
      assert.deepEqual(
        files.map((file) => readFileSync(file, 'utf8')),
        before,
      );
      assert.doesNotMatch(JSON.stringify(result), /private-scope-token/);
    }
    writeFileSync(files[0], JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'private-user-token' } }));
    writeFileSync(files[1], '{}');
    writeFileSync(files[2], JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '' } }));
    const shadowed = await nativeRuntimeReadiness(target, project, true);
    assert.equal(shadowed.status, 'unknown', 'a blank local override must not reuse a shadowed user credential');
    const unrelated = join(root, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(files[0], '{}');
    const outside = await nativeRuntimeReadiness(target, unrelated, true);
    assert.equal(outside.status, 'unknown', 'another workspace cannot borrow project-local credentials');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows BOM settings and an explicit native OAuth token are local configuration evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-api-bom-'));
  const names = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const file = join(root, 'settings.json');
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    for (const name of names.slice(1)) delete process.env[name];
    const target = { id: 'claude', installed: true, command: join(root, 'must-not-run') };
    const contents = `\uFEFF${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'private-bom-token' } })}`;
    writeFileSync(file, contents);
    assert.equal((await nativeRuntimeReadiness(target, root, true)).status, 'configured');
    assert.equal(readFileSync(file, 'utf8'), contents);
    writeFileSync(file, '{}');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'private-oauth-token';
    const observed = await nativeRuntimeReadiness(target, root, true);
    assert.equal(observed.status, 'configured');
    assert.doesNotMatch(JSON.stringify(observed), /private-oauth-token/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
