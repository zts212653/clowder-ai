import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const sourceEntity = {
  entityId: 'concept:fixture',
  type: 'concept',
  canonicalName: 'Fixture',
  aliases: ['oldword'],
  provenance: [{ source: 'fixture' }],
  updatedAt: '2026-01-01',
};
async function fixture(t, count = 20000) {
  const dir = mkdtempSync(join(tmpdir(), 'projection-process-'));
  const path = join(dir, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  const db = store.getDb();
  db.exec(
    "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES('doc:D','thread','active','Unrelated document','2026-01-01')",
  );
  const insert = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,position,created_at) VALUES('doc:D',?,'oldword newword',?,'2026-01-01')",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`p${i}`, i);
  })();
  await store.upsertEntities([sourceEntity]);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, db, dir, path, count };
}
function child(t, path, input, paused = '', released = '', mode = 'projection') {
  const worker = fork(
    new URL('../helpers/entity-projection-process.mjs', import.meta.url),
    [path, JSON.stringify(input), paused, released, mode],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => worker.kill('SIGKILL'));
  let stderr = '';
  worker.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    let result;
    worker.on('message', (message) => {
      result = message;
    });
    worker.on('error', reject);
    worker.on('close', (code) =>
      result ? resolve(result) : reject(new Error(`Fixture child exited ${code}: ${stderr}`)),
    );
  });
}
async function waitFor(path) {
  const deadline = Date.now() + 15000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, 'child must reach the deterministic staging barrier');
    await pause(5);
  }
}
const docProjection = { operation: 'mentions', docAnchors: ['doc:D'] };
const countMentions = (db) => db.prepare("SELECT count(*) AS n FROM entity_mentions WHERE doc_anchor='doc:D'").get().n;

for (const mode of ['projection', 'publication']) {
  test(`fixture ${mode} barrier is visible only after its payload is complete`, { timeout: 30000 }, async (t) => {
    const { dir, path } = await fixture(t, 500);
    const paused = join(dir, 'paused');
    const released = join(dir, 'released');
    const writeReleased = join(dir, 'write-released');
    const worker = fork(
      new URL('../helpers/entity-projection-process.mjs', import.meta.url),
      [path, JSON.stringify(docProjection), paused, released, mode, writeReleased],
      {
        execArgv: ['--import', new URL('../helpers/pause-projection-barrier-write.mjs', import.meta.url).href],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    t.after(() => worker.kill('SIGKILL'));
    let stderr = '';
    worker.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let result;
    const opened = new Promise((resolve) => {
      worker.on('message', (message) => {
        if (message.phase === 'barrier_file_opened') resolve();
        else result = message;
      });
    });
    const finished = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('close', (code) =>
        result ? resolve(result) : reject(new Error(`Barrier probe child exited ${code}: ${stderr}`)),
      );
    });
    try {
      await Promise.race([
        opened,
        finished.then((value) => {
          throw new Error(`Child completed before opening the barrier file: ${JSON.stringify(value)}`);
        }),
      ]);
      assert.equal(existsSync(paused), false, 'an opened but unwritten file must not signal readiness');
      writeFileSync(writeReleased, 'continue');
      await waitFor(paused);
      const payload = readFileSync(paused, 'utf8');
      if (mode === 'projection') assert.ok(Number.isSafeInteger(JSON.parse(payload).generation));
      else assert.equal(payload, 'locked');
    } finally {
      writeFileSync(writeReleased, 'continue');
      writeFileSync(released, 'continue');
      assert.equal((await finished).ok, true, 'the real projection must finish after release');
    }
  });
}

for (const scope of ['document', 'entity']) {
  test(
    `two real processes cannot discard in-flight ${scope} rows or publish an older overlapping projection`,
    { timeout: 30000 },
    async (t) => {
      const { store, db, dir, path, count } = await fixture(t);
      const paused = join(dir, 'paused');
      const released = join(dir, 'released');
      const input =
        scope === 'document'
          ? docProjection
          : {
              operation: 'entities',
              entities: [{ ...sourceEntity, aliases: ['newword'] }],
              context: { source: 'system' },
            };
      const first = child(t, path, input, paused, released);
      await Promise.race([
        waitFor(paused),
        first.then((result) => {
          throw new Error(`Child completed before staging barrier: ${JSON.stringify(result)}`);
        }),
      ]);
      const { generation } = JSON.parse(readFileSync(paused, 'utf8'));
      const before = db.prepare('SELECT count(*) AS n FROM entity_mention_rows WHERE generation=?').get(generation).n;
      assert.equal(before, 256);
      const second = await child(t, path, docProjection);
      assert.equal(second.ok, true, JSON.stringify(second));
      const retained = db.prepare('SELECT count(*) AS n FROM entity_mention_rows WHERE generation=?').get(generation).n;
      writeFileSync(released, 'continue');
      const result = await first;
      assert.equal(retained, before, 'newer publisher must not garbage-collect another live staging generation');
      assert.equal(result.ok, false, 'older overlapping projection must be rejected');
      assert.equal(result.retryable, true);
      assert.equal(countMentions(db), count);
      assert.equal(
        db.prepare("SELECT generation FROM entity_mention_doc_heads WHERE doc_anchor='doc:D'").get().generation,
        second.generation,
      );
      assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n, 0);
      assert.deepEqual((await store.getEntity(sourceEntity.entityId)).aliases, ['oldword']);
      // A fresh caller can retry and publish against the current snapshot/heads.
      await store.upsertEntities([{ ...sourceEntity, aliases: ['newword'] }]);
      assert.equal(countMentions(db), count);
      assert.deepEqual(db.prepare('SELECT DISTINCT surface FROM entity_mentions').all(), [{ surface: 'newword' }]);
    },
  );
}

test('publication takes the write reservation before reading its revision fence', { timeout: 30000 }, async (t) => {
  const { db, dir, path, count } = await fixture(t, 500);
  const paused = join(dir, 'publishing');
  const released = join(dir, 'continue');
  const publisher = child(t, path, docProjection, paused, released, 'publication');
  await Promise.race([
    waitFor(paused),
    publisher.then((result) => {
      throw new Error(`Child completed before publication barrier: ${JSON.stringify(result)}`);
    }),
  ]);
  const writer = child(t, path, {}, '', '', 'ledger');
  await pause(250);
  writeFileSync(released, 'continue');
  const [published, written] = await Promise.all([publisher, writer]);
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(countMentions(db), count);
});
