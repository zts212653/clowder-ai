import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findCodexProjectMcpConflict } from '../src/config/capabilities/codex-project-mcp-compatibility.js';

for (const input of [
  {
    name: 'legacy self table',
    text: '[mcp_servers.cat-cafe-memory]\ncommand="node"\nargs=["legacy.js"]\n',
    reason: 'legacy_stdio',
  },
  {
    name: 'quoted name and large integer',
    text: 'counter=9007199254740993\n[mcp_servers."cat-cafe-collab"]\ncommand="node"\n',
    reason: 'legacy_stdio',
  },
  { name: 'foreign name', text: '[mcp_servers.foreign]\ncommand="node"\n', reason: undefined },
  { name: 'native HTTP', text: '[mcp_servers.cat-cafe-memory]\nurl="http://127.0.0.1:1/mcp"\n', reason: undefined },
  { name: 'malformed user file', text: '[broken\n', reason: 'unreadable_config' },
])
  test(`project transport compatibility: ${input.name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f333-native-project-config-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.codex'));
    await mkdir(join(root, 'nested'));
    const path = join(root, '.codex/config.toml');
    await writeFile(path, input.text);
    const result = await findCodexProjectMcpConflict(join(root, 'nested'));
    assert.equal(result?.reason, input.reason);
    if (result) assert.equal(result.path, path);
    assert.equal(await readFile(path, 'utf8'), input.text, 'preview compatibility never migrates user files');
  });
