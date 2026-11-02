import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { test } from 'node:test';
import { PiAcpBridge } from '../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js';
import { PiSessionStore } from '../dist/domains/cats/services/agents/providers/pi/pi-session-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
for (const failure of ['corrupt-body', 'writer-busy', 'corrupt-binding']) {
  test(`cold MCP argv mismatch must not turn ${failure} into automatic boundary recovery`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-mismatch-gate-'));
    const store = new PiSessionStore({ root, scope: 'e'.repeat(64) });
    const old = [{ name: 'cat-cafe-collab', command: process.execPath, args: ['old-entry'], env: [] }];
    const changed = [{ ...old[0], args: ['new-entry'] }];
    const slot = store.create(root, old);
    const nativeFile = join(slot.directory, 'history.jsonl');
    const text =
      JSON.stringify({ type: 'session', version: 3, id: slot.id, cwd: root }) +
      '\n' +
      (failure === 'corrupt-body' ? 'not-json\n' : '');
    writeFileSync(nativeFile, text);
    if (failure === 'corrupt-binding') {
      const metadata = join(slot.directory, 'binding.json');
      writeFileSync(metadata, JSON.stringify({ v: 1, id: slot.id, cwd: root, binding: 'not-a-binding-digest' }));
    }
    if (failure === 'writer-busy') {
      const lock = join(slot.directory, 'writer-lock.sqlite');
      writeFileSync(lock, '');
      const db = new DatabaseSync(process.platform === 'win32' ? toNamespacedPath(lock) : lock);
      db.exec('BEGIN EXCLUSIVE');
      t.after(() => {
        db.exec('ROLLBACK');
        db.close();
      });
    }
    const responses = [];
    const bridge = new PiAcpBridge('never-start-a-model', [], (response) => responses.push(response), {
      root,
      scope: 'e'.repeat(64),
    });
    t.after(() => bridge.close());
    await bridge.handle({
      id: 1,
      method: 'session/load',
      params: { sessionId: slot.id, cwd: root, mcpServers: changed },
    });
    const observed = responses.find((response) => response.id === 1)?.error;
    console.log(
      'GATE_EVIDENCE',
      JSON.stringify({
        failure,
        code: observed?.code,
        typedRecovery: observed?.code === -32005,
        nativeUnchanged: readFileSync(nativeFile, 'utf8') === text,
        fixture: root,
      }),
    );
    assert.ok(observed, 'invalid or busy native history must be rejected');
    assert.equal(observed.code, -32004, 'only a valid and unowned old history may be reported as recoverable -32005');
    assert.equal(readFileSync(nativeFile, 'utf8'), text);
  });
}
