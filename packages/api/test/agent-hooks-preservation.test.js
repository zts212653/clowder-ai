// #1566: Agent hook sync must update only Clowder-managed entries and preserve everything else.
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';

const bashCmd = (scriptPath) => `bash "${scriptPath}"`;
const command = (cmd) => ({ hooks: [{ type: 'command', command: cmd }] });
const thirdParty = (label) => command(`echo third-party-${label}`);

async function createProjectRoot() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-preserve-project-'));
  const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
  await mkdir(hookDir, { recursive: true });
  await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
  await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');
  return projectRoot;
}

describe('#1566 agent hook sync preserves third-party configuration', () => {
  let projectRoot;
  let targetRoot;
  let startScript;
  let stopScript;
  let targets;

  beforeEach(async () => {
    projectRoot = await createProjectRoot();
    targetRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-preserve-home-'));
    startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    stopScript = join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh');
    targets = [
      { name: 'codex-hooks', dir: '.codex', stop: `${bashCmd(stopScript)} --codex-json` },
      { name: 'gemini-hooks', dir: '.gemini', stop: bashCmd(stopScript) },
    ];
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  async function writeJson(relativePath, value) {
    const path = join(targetRoot, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path, text, 'utf8');
    return { path, text };
  }

  async function targetHealth(name) {
    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    return status.targets.find((target) => target.name === name);
  }

  it('keeps Codex/Gemini third-party handlers, unknown fields and positions when managed entries are current', async () => {
    for (const target of targets) {
      const original = {
        description: 'user-maintained hooks',
        hooks: {
          SessionStart: [command(bashCmd(startScript)), thirdParty('start')],
          Stop: [command(target.stop)],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo third-party-tool' }] }],
        },
      };
      const { path, text } = await writeJson(join(target.dir, 'hooks.json'), original);

      assert.equal((await targetHealth(target.name))?.status, 'configured', `${target.name} mixed file is healthy`);
      await syncAgentHooks({ projectRoot, targetRoot });
      assert.equal(await readFile(path, 'utf8'), text, `${target.name} must not be rewritten`);
    }
  });

  it('appends missing managed entries after third-party groups and stays idempotent', async () => {
    for (const target of targets) {
      const { path } = await writeJson(join(target.dir, 'hooks.json'), {
        hooks: { SessionStart: [thirdParty('start')], Stop: [thirdParty('stop')] },
      });

      await syncAgentHooks({ projectRoot, targetRoot });
      const first = await readFile(path, 'utf8');
      assert.deepEqual(JSON.parse(first).hooks, {
        SessionStart: [thirdParty('start'), command(bashCmd(startScript))],
        Stop: [thirdParty('stop'), command(target.stop)],
      });

      await syncAgentHooks({ projectRoot, targetRoot });
      assert.equal(await readFile(path, 'utf8'), first, `${target.name} repeated sync adds nothing`);
      assert.equal((await targetHealth(target.name))?.status, 'configured');
    }
  });

  it('updates outdated managed commands in place so third-party positions never shift', async () => {
    const readmeStart = 'bash "$HOME/.claude/hooks/session-start-recall.sh"';
    const { path } = await writeJson('.codex/hooks.json', {
      hooks: {
        // Documented README template + the pre-2026-05-22 Codex Stop spelling (no --codex-json).
        SessionStart: [command(readmeStart), thirdParty('start')],
        Stop: [command(bashCmd(stopScript)), thirdParty('stop')],
      },
    });
    assert.equal((await targetHealth('codex-hooks'))?.status, 'stale');

    await syncAgentHooks({ projectRoot, targetRoot });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).hooks, {
      // An equivalent spelling is kept: rewriting it would change its Codex trust hash.
      SessionStart: [command(readmeStart), thirdParty('start')],
      Stop: [command(`${bashCmd(stopScript)} --codex-json`), thirdParty('stop')],
    });
    assert.equal((await targetHealth('codex-hooks'))?.status, 'configured');
  });

  it('refuses to rewrite Codex hooks.json when duplicate managed entries would need removal', async () => {
    const { path, text } = await writeJson('.codex/hooks.json', {
      hooks: {
        SessionStart: [command(bashCmd(startScript)), thirdParty('start'), command(bashCmd(startScript))],
        Stop: [command(`${bashCmd(stopScript)} --codex-json`)],
      },
    });

    await syncAgentHooks({ projectRoot, targetRoot });
    assert.equal(await readFile(path, 'utf8'), text, 'removing a duplicate would shift Codex trust keys');
    const health = await targetHealth('codex-hooks');
    assert.equal(health?.status, 'stale');
    assert.match(health?.reason ?? '', /duplicate/i);
  });

  it('leaves malformed or structurally unexpected hook files untouched', async () => {
    const cases = ['{ not json', '[]', '{"hooks": []}', '{"hooks": {"Stop": {"hooks": []}}}'];
    for (const content of cases) {
      const { path } = await writeJson('.codex/hooks.json', content);
      await syncAgentHooks({ projectRoot, targetRoot });
      assert.equal(await readFile(path, 'utf8'), content, `must not overwrite: ${content}`);
      assert.equal((await targetHealth('codex-hooks'))?.status, 'error', `reports error: ${content}`);
    }
  });

  it('refuses invalid group/handler structure under any event, since the CLI then loads no hooks at all', async () => {
    // Codex 0.159.3 rejects the whole hooks.json for each of these (hooks/list: 0 hooks + parse warning).
    const managed = () => ({ SessionStart: [command(bashCmd(startScript))], Stop: [command(bashCmd(stopScript))] });
    const invalidHooks = [
      { SessionStart: [null] },
      { SessionStart: [{ hooks: 'not-array' }] },
      { SessionStart: [{ hooks: [{ type: 'command', command: 42 }] }] },
      { ...managed(), PreToolUse: [{ hooks: 'not-array' }] },
      { ...managed(), PreToolUse: [{ matcher: 7, hooks: [] }] },
      { ...managed(), PreToolUse: [{ hooks: [{ command: 'echo missing-type' }] }] },
      { ...managed(), PreToolUse: [{ hooks: [{ type: 'command', command: 'echo x', timeout: '5' }] }] },
    ];
    for (const hooks of invalidHooks) {
      const label = JSON.stringify(hooks).slice(0, 120);
      for (const [file, name] of [
        ['.codex/hooks.json', 'codex-hooks'],
        ['.gemini/hooks.json', 'gemini-hooks'],
        ['.claude/settings.json', 'claude-settings'],
      ]) {
        const { path, text } = await writeJson(file, { hooks });
        await syncAgentHooks({ projectRoot, targetRoot });
        assert.equal(await readFile(path, 'utf8'), text, `${name} must stay untouched: ${label}`);
        const health = await targetHealth(name);
        assert.equal(health?.status, 'error', `${name} must report error: ${label}`);
        assert.match(health?.reason ?? '', /hooks\.\w+\[\d+\]/, `${name} reason names the location: ${label}`);
      }
    }
  });

  it('keeps a symlinked hooks.json as a symlink and merges into its target', async () => {
    const realPath = join(targetRoot, 'dotfiles', 'codex-hooks.json');
    await writeJson('dotfiles/codex-hooks.json', { hooks: { SessionStart: [thirdParty('start')] } });
    await mkdir(join(targetRoot, '.codex'), { recursive: true });
    const linkPath = join(targetRoot, '.codex', 'hooks.json');
    await symlink(realPath, linkPath);

    await syncAgentHooks({ projectRoot, targetRoot });
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
    const merged = JSON.parse(await readFile(realPath, 'utf8'));
    assert.deepEqual(merged.hooks.SessionStart, [thirdParty('start'), command(bashCmd(startScript))]);
  });

  it('keeps Claude commands that only resemble managed hooks (traversal, subdirectory, extra args)', async () => {
    const lookalikes = [
      // Literal traversal spelling from the #1566 reproduction (join() would normalise '..' away).
      bashCmd(`${join(targetRoot, '.claude', 'hooks')}/../../external/session-start-recall.sh`),
      bashCmd(join(targetRoot, '.claude', 'hooks', 'sub', 'session-start-recall.sh')),
      `${bashCmd(startScript)} --verbose`,
      `${bashCmd(startScript)} && echo extra`,
      bashCmd(join(targetRoot, 'external', 'session-start-recall.sh')),
    ];
    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    await writeJson('.claude/settings.json', {
      permissions: { allow: ['Read'] },
      hooks: { SessionStart: lookalikes.map((cmd) => command(cmd)) },
    });

    await syncAgentHooks({ projectRoot, targetRoot });
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.deepEqual(settings.hooks.SessionStart, [
      ...lookalikes.map((cmd) => command(cmd)),
      command(bashCmd(startScript)),
    ]);
    assert.deepEqual(settings.hooks.Stop, [command(bashCmd(stopScript))]);
    assert.equal((await targetHealth('claude-settings'))?.status, 'configured');
  });

  it('converges every historical Clowder spelling to one managed Claude entry', async () => {
    const spellings = [
      bashCmd(startScript),
      startScript,
      '"$HOME/.claude/hooks/session-start-recall.sh"',
      'bash "$HOME/.claude/hooks/session-start-recall.sh"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash variable, not JS template
      'bash "${HOME}/.claude/hooks/session-start-recall.sh"',
      '~/.claude/hooks/session-start-recall.sh',
      bashCmd(startScript.replace(/\//g, '\\')),
    ];
    for (const spelling of spellings) {
      const settingsPath = join(targetRoot, '.claude', 'settings.json');
      await writeJson('.claude/settings.json', {
        hooks: { SessionStart: [command(spelling), thirdParty('start')], Stop: [command(bashCmd(stopScript))] },
      });

      await syncAgentHooks({ projectRoot, targetRoot });
      const { hooks } = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.deepEqual(hooks.SessionStart[1], thirdParty('start'), `third-party kept for ${spelling}`);
      assert.equal(hooks.SessionStart.length, 2, `recognised in place, nothing appended for ${spelling}`);
      assert.equal((await targetHealth('claude-settings'))?.status, 'configured', `healthy after ${spelling}`);
    }
  });
});
