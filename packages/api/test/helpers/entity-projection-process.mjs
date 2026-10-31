import { channel } from 'node:diagnostics_channel';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { EntityRegistryStore } from '../../dist/domains/memory/EntityRegistry.js';
import { publishEntityMentions } from '../../dist/domains/memory/publish-entity-mentions.js';

const [path, encoded, paused, released, mode = 'projection'] = process.argv.slice(2);
const db = new Database(path);
db.pragma('foreign_keys=ON');
function publishPaused(payload) {
  // Existence is the parent's readiness signal: publish only a complete payload.
  const pending = `${paused}.${process.pid}.pending`;
  writeFileSync(pending, payload);
  renameSync(pending, paused);
}
const wait = () => {
  const deadline = Date.now() + 15000;
  while (!existsSync(released)) {
    if (Date.now() > deadline) throw new Error('Fixture barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
let generation;
const events = channel('cat-cafe.entity-mention-projection');
const observe = (event) => {
  if (generation !== undefined || event.phase !== 'staging') return;
  generation = event.generation;
  if (paused && mode === 'projection') {
    publishPaused(JSON.stringify({ generation }));
    wait();
  }
};
events.subscribe(observe);
try {
  if (mode === 'ledger') {
    db.prepare(
      "INSERT INTO task_run_ledger(task_id,subject_key,outcome,duration_ms,started_at) VALUES('fixture','concurrent','delivered',0,1)",
    ).run();
  } else {
    const input = JSON.parse(encoded);
    await publishEntityMentions(db, path, input, () => {
      if (input.operation === 'entities') new EntityRegistryStore(db).upsert(input.entities, input.context);
      if (mode === 'publication') {
        publishPaused('locked');
        wait();
      }
    });
  }
  process.send?.({ ok: true, generation });
} catch (error) {
  process.send?.({ ok: false, generation, message: error.message, code: error.code, retryable: error.retryable });
} finally {
  events.unsubscribe(observe);
  db.close();
  process.disconnect?.();
}
