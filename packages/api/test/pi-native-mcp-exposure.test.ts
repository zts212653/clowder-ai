import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { piMcpExtension } from '../src/domains/cats/services/agents/providers/pi/pi-session-mcp.js';

test('the generated Pi extension lets the native client choose tool exposure instead of forcing full schemas', async (t) => {
  const extension = piMcpExtension('native-exposure-test', [
    { name: 'cat-cafe-collab', command: process.execPath, args: ['fixture.js'], env: [] },
  ]);
  const directory = extension.directory;
  assert.ok(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = await import(pathToFileURL(join(directory, 'session-mcp.mjs')).href);
  const registrations: { name: string; config: Record<string, unknown> }[] = [];
  entry.default({
    registerMcpServer: (name: string, config: Record<string, unknown>) => registrations.push({ name, config }),
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.config.exposure, undefined);
  assert.equal(registrations[0]?.config.command, process.execPath);
  assert.deepEqual(registrations[0]?.config.args, ['fixture.js']);
});
