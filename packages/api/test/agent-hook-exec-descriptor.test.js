// #1570 review: ownership is decided by the complete execution descriptor. Clowder only ever writes a
// group `{hooks:[…]}` holding `{type:"command", command:<known spelling>}`; any execution-shaping field
// (exec-form `args`, `shell`, conditions, async, platform overrides, matcher…) makes the handler someone
// else's, so it is preserved byte-for-byte in place and never rewritten or removed as a duplicate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';

/** Length of the common prefix and suffix; original[start, end) is what changed. */
function changedRegion(original, after) {
  let start = 0;
  while (start < original.length && original[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < original.length - start && original.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
  return { start, end: original.length - suffix };
}

describe('#1570 managed ownership uses the complete execution descriptor', () => {
  let projectRoot;
  let targetRoot;
  let startScript;
  let start;
  let stop;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'hook-exec-project-'));
    const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
    await mkdir(hookDir, { recursive: true });
    await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', 'utf8');
    await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    targetRoot = await mkdtemp(join(tmpdir(), 'hook-exec-home-'));
    startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    start = `bash "${startScript}"`;
    stop = `bash "${join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')}"`;
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  async function syncDocument(file, document) {
    const path = join(targetRoot, file);
    await mkdir(join(path, '..'), { recursive: true });
    const before = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(path, before, 'utf8');
    await syncAgentHooks({ projectRoot, targetRoot });
    return { path, before, after: await readFile(path, 'utf8') };
  }

  async function health(name) {
    return (await getAgentHookStatus({ projectRoot, targetRoot })).targets.find((target) => target.name === name);
  }

  const managed = (command) => ({ hooks: [{ type: 'command', command }] });

  it('keeps a lone exec-form handler in place, still directly executable', async () => {
    for (const args of [['--third-party-mode'], []]) {
      const custom = { hooks: [{ type: 'command', command: startScript, args }] };
      const { after } = await syncDocument('.claude/settings.json', { hooks: { SessionStart: [custom] } });
      const { hooks } = JSON.parse(after);
      assert.deepEqual(hooks.SessionStart[0], custom, `exec-form handler untouched (args ${JSON.stringify(args)})`);
      assert.deepEqual(hooks.SessionStart[1], managed(start), 'Clowder entry appended after it');
      const preserved = hooks.SessionStart[0].hooks[0];
      const run = spawnSync(preserved.command, preserved.args, { encoding: 'utf8' });
      assert.equal(run.status, 0, `direct invocation still works: ${run.error?.code ?? ''}`);
      assert.equal(run.stdout.trim(), args.join('\n'));
      assert.equal((await health('claude-settings'))?.status, 'configured');
    }
  });

  it('never treats an exec-form handler as a duplicate of the managed shell-form one', async () => {
    const custom = { hooks: [{ type: 'command', command: startScript, args: ['--third-party-mode'] }] };
    const document = { hooks: { SessionStart: [managed(start), custom], Stop: [managed(stop)] } };
    const { before, after } = await syncDocument('.claude/settings.json', document);
    assert.equal(after, before, 'nothing to change: managed entries current, custom group kept');
    assert.equal((await health('claude-settings'))?.status, 'configured');
  });

  it('preserves every execution-shaping variant of a Clowder-looking handler (Claude and Codex)', async () => {
    const variants = {
      '.claude/settings.json': [
        { handler: { args: [] } },
        { handler: { shell: 'bash' } },
        { handler: { async: true } },
        { handler: { asyncRewake: true } },
        { handler: { if: 'Bash(git *)' } },
        { handler: { once: true } },
        { handler: { timeout: 30 } },
        { handler: { statusMessage: 'custom' } },
        { group: { matcher: 'startup' } },
        { group: { note: 'user group' } },
      ],
      '.codex/hooks.json': [
        { handler: { commandWindows: 'cmd /c start.cmd' } },
        { handler: { command_windows: 'cmd /c start.cmd' } },
        { handler: { timeout: 5 } },
        { handler: { async: true } },
        { handler: { statusMessage: 'custom' } },
        { handler: { additionalContextLimit: 0 } },
        { group: { matcher: 'startup' } },
      ],
    };
    for (const [file, cases] of Object.entries(variants)) {
      const name = file.startsWith('.codex') ? 'codex-hooks' : 'claude-settings';
      const stopCommand = name === 'codex-hooks' ? `${stop} --codex-json` : stop;
      for (const { handler = {}, group = {} } of cases) {
        const custom = { ...group, hooks: [{ type: 'command', command: start, ...handler }] };
        const label = `${name} ${JSON.stringify({ ...group, ...handler })}`;
        const { before, after } = await syncDocument(file, {
          hooks: { SessionStart: [custom], Stop: [managed(stopCommand)] },
        });
        const region = changedRegion(before, after);
        assert.equal(region.start, region.end, `${label}: original bytes kept, only an insertion`);
        const { hooks } = JSON.parse(after);
        assert.deepEqual(hooks.SessionStart, [custom, managed(start)], `${label}: kept in place, managed appended`);
        assert.equal((await health(name))?.status, 'configured', `${label}: healthy`);
        await syncAgentHooks({ projectRoot, targetRoot });
        assert.equal(await readFile(join(targetRoot, file), 'utf8'), after, `${label}: repeat sync is a no-op`);
      }
    }
  });

  it('refuses without writing when exec-form handlers sit beside duplicate managed entries (Codex)', async () => {
    const custom = { hooks: [{ type: 'command', command: startScript, args: ['--x'] }] };
    const document = { hooks: { SessionStart: [managed(start), custom, managed(start)] } };
    const { before, after } = await syncDocument('.codex/hooks.json', document);
    assert.equal(after, before, 'refusal leaves the whole file untouched');
    assert.match((await health('codex-hooks'))?.reason ?? '', /duplicate/);
  });
});
