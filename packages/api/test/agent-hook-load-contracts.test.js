// #1566: shared hook files are merged, and reported configured, only within the loading contract
// verified for the CLI that reads them (Codex 0.159.3 source; Claude Code 2.1.286 docs + black-box).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';

const bashCmd = (scriptPath) => `bash "${scriptPath}"`;
const group = (handler, extra = {}) => ({ ...extra, hooks: [handler] });
const thirdParty = (fields = {}) => ({ type: 'command', command: 'echo third-party', ...fields });

describe('#1566 hook load contracts', () => {
  let projectRoot;
  let targetRoot;
  let start;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'hook-contract-project-'));
    const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
    await mkdir(hookDir, { recursive: true });
    await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');
    targetRoot = await mkdtemp(join(tmpdir(), 'hook-contract-home-'));
    start = { type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')) };
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  /** Writes a file whose managed Stop entry is missing, so sync always has something to merge. */
  async function syncWith(file, document) {
    const path = join(targetRoot, file);
    await mkdir(join(path, '..'), { recursive: true });
    const text = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(path, text, 'utf8');
    await syncAgentHooks({ projectRoot, targetRoot });
    return { text, after: await readFile(path, 'utf8') };
  }

  async function health(name) {
    return (await getAgentHookStatus({ projectRoot, targetRoot })).targets.find((target) => target.name === name);
  }

  async function expectRefused(file, name, document, cli) {
    const label = JSON.stringify(document).slice(0, 160);
    const { text, after } = await syncWith(file, document);
    assert.equal(after, text, `${name} must stay untouched: ${label}`);
    const result = await health(name);
    assert.equal(result?.status, 'error', `${name} must report error: ${label}`);
    assert.match(result?.reason ?? '', cli, `${name} reason names the verified CLI: ${label}`);
  }

  async function expectMerged(file, name, document, status = 'configured') {
    const label = JSON.stringify(document).slice(0, 160);
    const { after } = await syncWith(file, document);
    const merged = JSON.parse(after);
    assert.equal(merged.hooks.Stop?.length, 1, `${name} managed Stop appended: ${label}`);
    const { Stop: _stop, ...rest } = merged.hooks;
    assert.deepEqual(rest, document.hooks, `${name} keeps every other entry as-is: ${label}`);
    assert.equal((await health(name))?.status, status, `${name} health: ${label}`);
  }

  it('Codex: refuses what Codex 0.159.3 cannot load (it would load no hook at all)', async () => {
    const preToolUse = [
      thirdParty({ timeout: -1 }),
      thirdParty({ timeout: 0.5 }),
      thirdParty({ async: 'yes' }),
      thirdParty({ async: null }),
      thirdParty({ commandWindows: 42 }),
      thirdParty({ statusMessage: false }),
      thirdParty({ additionalContextLimit: -1 }),
      { type: 'unknown-future-handler', command: 'echo x' },
      { type: 'http', url: 'https://example.invalid/hook' },
      { type: 'mcp_tool' },
      { type: 'mcp_tool', server: 's', tool: 't', input: { nested: { value: null } } },
    ].map((handler) => ({ hooks: { SessionStart: [group(start)], PreToolUse: [group(handler)] } }));
    const root = [
      { $schema: 'https://example.invalid/schema.json', hooks: { SessionStart: [group(start)] } },
      { description: 5, hooks: { SessionStart: [group(start)] } },
    ];
    for (const document of [...preToolUse, ...root]) {
      await expectRefused('.codex/hooks.json', 'codex-hooks', document, /Codex CLI 0\.159\.3/);
    }
  });

  it('Codex: accepts shapes Codex loads even where Claude would not', async () => {
    const cases = [
      { PreToolUse: [{ matcher: 'Bash' }] },
      { PreToolUse: [group(thirdParty(), { matcher: null })] },
      { PreToolUse: [group(thirdParty({ timeout: null, statusMessage: null, additionalContextLimit: 0 }))] },
      { PreToolUse: [group(thirdParty({ timeout: 0, async: true, futureField: { any: 1 } }))] },
      { PreToolUse: [group({ type: 'prompt' }), group({ type: 'agent' })] },
      { PreToolUse: [group({ type: 'mcp_tool', server: 's', tool: 't', input: { a: [1, 'b'] } })] },
      { FutureEvent: 'ignored by Codex' },
    ];
    for (const hooks of cases) {
      await expectMerged('.codex/hooks.json', 'codex-hooks', {
        description: 'user hooks',
        hooks: { SessionStart: [group(start)], ...hooks },
      });
    }
  });

  it('Claude: refuses hooks Claude Code 2.1.286 does not load', async () => {
    const cases = [
      group(thirdParty({ timeout: 0 })),
      group(thirdParty({ timeout: null })),
      group(thirdParty({ timeout: -1 })),
      group(thirdParty(), { matcher: null }),
      group(thirdParty({ shell: 'fish' })),
      group(thirdParty({ statusMessage: false })),
      group(thirdParty({ async: 'yes' })),
      group({ type: 'prompt' }),
      group({ type: 'unknown-future-handler', command: 'echo x' }),
      { matcher: 'Bash' },
    ];
    for (const entry of cases) {
      const document = { model: 'opus', hooks: { SessionStart: [group(start)], PreToolUse: [entry] } };
      await expectRefused('.claude/settings.json', 'claude-settings', document, /Claude Code 2\.1\.286/);
    }
  });

  it('Claude: accepts documented handler types, empty groups and fields it ignores', async () => {
    const cases = [
      { PreToolUse: [{ hooks: [] }] },
      { PreToolUse: [group(thirdParty({ futureField: 1, timeout: 0.5, args: ['-c'] }), { note: 'x' })] },
      { PreToolUse: [group({ type: 'http', url: 'https://example.invalid/hook', headers: { A: 'b' } })] },
      { PreToolUse: [group({ type: 'mcp_tool', server: 's', tool: 't', input: { a: null } })] },
      { PreToolUse: [group({ type: 'prompt', prompt: 'check $ARGUMENTS' }), group({ type: 'agent', prompt: 'p' })] },
      { FooEvent: [group(thirdParty())] },
    ];
    for (const hooks of cases) {
      await expectMerged('.claude/settings.json', 'claude-settings', {
        hooks: { SessionStart: [group(start)], ...hooks },
      });
    }
  });

  it('Gemini: enforces only the shared structure and says CLI loading is unverified', async () => {
    const document = { hooks: { SessionStart: [group(start)], BeforeTool: [group({ type: 'future', x: 1 })] } };
    await expectMerged('.gemini/hooks.json', 'gemini-hooks', document);
    assert.match((await health('gemini-hooks'))?.reason ?? '', /not verified/);
    const invalid = { hooks: { SessionStart: [group(start)], BeforeTool: [group(thirdParty({ command: 42 }))] } };
    await expectRefused('.gemini/hooks.json', 'gemini-hooks', invalid, /shared hook structure/);
  });
});
