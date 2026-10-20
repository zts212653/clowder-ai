// #1566: reading preconditions. Bytes Clowder cannot round-trip are never rewritten, and each CLI's
// reader limits (Codex 0.159.3: no BOM, well-formed Unicode, depth <= 127; Claude Code 2.1.286 accepts
// BOM and unpaired surrogate escapes) decide whether a file is reported configured.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';

const TARGETS = [
  ['.codex/hooks.json', 'codex-hooks'],
  ['.claude/settings.json', 'claude-settings'],
  ['.gemini/hooks.json', 'gemini-hooks'],
];

describe('#1566 hook config reading preconditions', () => {
  let projectRoot;
  let targetRoot;
  let managedStart;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'hook-reader-project-'));
    const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
    await mkdir(hookDir, { recursive: true });
    await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');
    targetRoot = await mkdtemp(join(tmpdir(), 'hook-reader-home-'));
    const command = `bash "${join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')}"`;
    managedStart = `"SessionStart":[{"hooks":[{"type":"command","command":${JSON.stringify(command)}}]}]`;
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  /** Writes raw bytes (managed Stop missing, so sync always wants to edit) and syncs. */
  async function syncBytes(file, bytes) {
    const path = join(targetRoot, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    await syncAgentHooks({ projectRoot, targetRoot });
    return readFile(path);
  }

  async function health(name) {
    return (await getAgentHookStatus({ projectRoot, targetRoot })).targets.find((target) => target.name === name);
  }

  /** Shape every CLI accepts: description string, managed SessionStart, optional extra hook events. */
  const doc = (description = '"d"', extraEvents = '') =>
    `{"description":${description},"hooks":{${managedStart}${extraEvents}}}`;

  it('never rewrites a file that is not valid UTF-8', async () => {
    for (const invalid of [[0xff], [0xe2, 0x82]]) {
      const [before, after] = doc().split('"d"');
      const bytes = Buffer.concat([Buffer.from(`${before}"`), Buffer.from(invalid), Buffer.from(`"${after}`)]);
      for (const [file, name] of TARGETS) {
        assert.ok((await syncBytes(file, bytes)).equals(bytes), `${name} keeps bytes ${invalid}`);
        const result = await health(name);
        assert.equal(result?.status, 'error');
        assert.match(result?.reason ?? '', /UTF-8/);
      }
    }
  });

  it('keeps a byte order mark where the CLI accepts it and refuses it for Codex', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(doc())]);
    for (const [file, name] of TARGETS) {
      const after = await syncBytes(file, bytes);
      if (name === 'codex-hooks') {
        assert.ok(after.equals(bytes), 'Codex 0.159.3 rejects a BOM: left untouched');
        assert.match((await health(name))?.reason ?? '', /byte order mark/);
        continue;
      }
      assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} keeps the BOM`);
      assert.ok(after.subarray(3).toString('utf8').startsWith(doc().slice(0, -2)), `${name} keeps the rest`);
      assert.equal((await health(name))?.status, 'configured');
    }
  });

  async function expectSurrogateVerdict(bytes, label) {
    for (const [file, name] of TARGETS) {
      const after = (await syncBytes(file, bytes)).toString('utf8');
      if (name === 'codex-hooks') {
        assert.equal(after, bytes.toString('utf8'), `Codex left untouched: ${label}`);
        assert.match((await health(name))?.reason ?? '', /surrogate/, `Codex reason: ${label}`);
        continue;
      }
      assert.ok(after.includes(label), `${name} keeps the escape verbatim: ${label}`);
      assert.equal((await health(name))?.status, 'configured', `${name} healthy: ${label}`);
    }
  }

  it('refuses unpaired surrogate escapes for Codex only', async () => {
    for (const surrogate of ['\\ud800', '\\udc00', '\\ud800\\ud801']) {
      const inDescription = `"x${surrogate}"`;
      await expectSurrogateVerdict(Buffer.from(doc(inDescription)), inDescription);
      // Codex ignores unknown event names, but its JSON reader still rejects the key.
      const inKey = `,"${surrogate}":[]`;
      await expectSurrogateVerdict(Buffer.from(doc(undefined, inKey)), inKey);
    }
    const pair = Buffer.from(doc('"\\ud83d\\ude00"'));
    assert.ok((await syncBytes('.codex/hooks.json', pair)).toString('utf8').includes('\\ud83d\\ude00'));
    assert.equal((await health('codex-hooks'))?.status, 'configured');
  });

  it('applies Codex nesting limit (127 levels) and the reader limit (256) without touching bytes', async () => {
    const nested = (arrays) => `${'['.repeat(arrays)}0${']'.repeat(arrays)}`;
    const mcp = (arrays) =>
      `{"hooks":{${managedStart},"PreToolUse":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t","input":{"x":${nested(arrays)}}}]}]}}`;
    // Root, hooks, PreToolUse, group, hooks, handler and input are 7 levels; 120 arrays make 127.
    assert.ok((await syncBytes('.codex/hooks.json', Buffer.from(mcp(120)))).toString().includes('"Stop"'));
    assert.equal((await health('codex-hooks'))?.status, 'configured');
    const tooDeep = Buffer.from(mcp(121));
    assert.ok((await syncBytes('.codex/hooks.json', tooDeep)).equals(tooDeep));
    assert.match((await health('codex-hooks'))?.reason ?? '', /nest/);

    const claude = (arrays) => `{"env":{"x":${nested(arrays)}},"hooks":{${managedStart}}}`;
    assert.ok((await syncBytes('.claude/settings.json', Buffer.from(claude(200)))).toString().includes('"Stop"'));
    assert.equal((await health('claude-settings'))?.status, 'configured');
    const beyondReader = Buffer.from(claude(300));
    assert.ok((await syncBytes('.claude/settings.json', beyondReader)).equals(beyondReader));
    assert.match((await health('claude-settings'))?.reason ?? '', /nest/);
  });
});
