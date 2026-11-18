import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const environmentKey = 'CAT_CAFE_TEST_KNN_WITNESS_ROOT';
const rowFunction = 'fixture_knn_row';
const root = process.env[environmentKey];

// This preload runs only in the fixture's child. A TEMP view wraps the real main
// vec0 table without changing its schema or the production query/diagnostics.
if (root) {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql, ...args) {
    if (/^SELECT passage_key as passageKey, distance FROM passage_vectors\b/.test(sql)) {
      const armPath = join(root, 'armed.json');
      const arm = existsSync(armPath) ? JSON.parse(readFileSync(armPath, 'utf8')) : undefined;
      const sqlFingerprint = createHash('sha256').update(sql).digest('hex');
      this.function(rowFunction, (key) => {
        if (arm) {
          const path = join(root, `${arm.queryId}.json`);
          writeFileSync(
            `${path}.pending`,
            JSON.stringify({ ...arm, pid: process.pid, sqlFingerprint, phase: 'sqlite-row' }),
          );
          renameSync(`${path}.pending`, path);
          // Hold the actual statement.all/sqlite3_step stack until the parent
          // kills this child. This is not evidence of ongoing distance math.
          const gate = new Int32Array(new SharedArrayBuffer(4));
          for (;;) Atomics.wait(gate, 0, 0);
        }
        return key;
      });
      this.exec(`CREATE TEMP VIEW IF NOT EXISTS passage_vectors AS
        SELECT ${rowFunction}(passage_key) AS passage_key, embedding, distance, k FROM main.passage_vectors`);
    }
    return Reflect.apply(prepare, this, [sql, ...args]);
  };
}

export function nativeKnnWitness(t, directory) {
  const previousRoot = process.env[environmentKey];
  const previousOptions = process.env.NODE_OPTIONS;
  process.env[environmentKey] = directory;
  process.env.NODE_OPTIONS = `${previousOptions ?? ''} --import=${import.meta.url}`.trim();
  t.after(() => {
    for (const [key, value] of [
      [environmentKey, previousRoot],
      ['NODE_OPTIONS', previousOptions],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return {
    arm(reason) {
      const arm = { queryId: randomUUID(), reason };
      writeFileSync(join(directory, 'armed.json'), JSON.stringify(arm));
      return arm;
    },
    entered(arm) {
      return existsSync(join(directory, `${arm.queryId}.json`));
    },
    assertEntered(arm, snapshot) {
      assert.ok(this.entered(arm), 'must enter SQLite, not merely emit the pre-call sql-start event');
      const witness = JSON.parse(readFileSync(join(directory, `${arm.queryId}.json`), 'utf8'));
      assert.equal(witness.queryId, arm.queryId);
      assert.equal(witness.reason, arm.reason);
      assert.equal(witness.pid, snapshot.pid);
      assert.equal(witness.sqlFingerprint, snapshot.nativeVectorRead.sqlFingerprint);
      assert.equal(witness.phase, 'sqlite-row');
    },
  };
}
