// F198 Phase C - AC-C4: GET /api/agent-sessions
// Verifies the endpoint reads ~/.claude/jobs/<shortId>/state.json and returns
// aggregated active daemon sessions.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAgentSessions } from '../dist/domains/terminal/agent-sessions-reader.js';

test('F198-C AC-C4: readAgentSessions returns list of job state snapshots from jobsDir', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-sessions-test-'));

  const job1 = join(jobsDir, 'abcd1234');
  const job2 = join(jobsDir, 'efgh5678');
  mkdirSync(job1, { recursive: true });
  mkdirSync(job2, { recursive: true });

  writeFileSync(
    join(job1, 'state.json'),
    JSON.stringify({ state: 'working', detail: 'searching for context...', daemonShort: 'abcd1234' }),
  );
  writeFileSync(
    join(job2, 'state.json'),
    JSON.stringify({ state: 'done', output: { result: 'done' }, daemonShort: 'efgh5678' }),
  );

  const sessions = await readAgentSessions(jobsDir);
  assert.ok(Array.isArray(sessions), 'must return array');
  assert.equal(sessions.length, 2, 'must return one entry per job directory');

  const working = sessions.find((s) => s.daemonShortId === 'abcd1234');
  assert.ok(working, 'must include working job');
  assert.equal(working.state, 'working');
  assert.equal(working.detail, 'searching for context...');

  const done = sessions.find((s) => s.daemonShortId === 'efgh5678');
  assert.ok(done, 'must include done job');
  assert.equal(done.state, 'done');
});

test('F198-C AC-C4: readAgentSessions returns empty array when no jobs dir exists', async () => {
  const sessions = await readAgentSessions('/tmp/nonexistent-cat-cafe-jobs-xyz');
  assert.deepEqual(sessions, [], 'must return empty array when jobsDir does not exist');
});

test('F198-C AC-C4: readAgentSessions skips dirs without state.json (malformed jobs)', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-sessions-skip-test-'));
  const goodJob = join(jobsDir, 'good0001');
  const badJob = join(jobsDir, 'bad00002');
  mkdirSync(goodJob, { recursive: true });
  mkdirSync(badJob, { recursive: true }); // no state.json

  writeFileSync(join(goodJob, 'state.json'), JSON.stringify({ state: 'working', daemonShort: 'good0001' }));

  const sessions = await readAgentSessions(jobsDir);
  assert.equal(sessions.length, 1, 'must skip dirs without state.json');
  assert.equal(sessions[0].daemonShortId, 'good0001');
});

test('F198-C P1-2: readAgentSessions strips output and linkScanPath from returned snapshots', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-sessions-strip-test-'));
  const job1 = join(jobsDir, 'abcd9999');
  mkdirSync(job1, { recursive: true });

  writeFileSync(
    join(job1, 'state.json'),
    JSON.stringify({
      daemonShort: 'abcd9999',
      state: 'done',
      detail: 'finished',
      cwd: '/home/user/project',
      output: { result: 'sensitive model output text' },
      linkScanPath: '/home/user/.claude/jobs/abcd9999/transcript.jsonl',
    }),
  );

  const sessions = await readAgentSessions(jobsDir);
  assert.equal(sessions.length, 1);
  const snap = sessions[0];
  assert.equal(snap.daemonShortId, 'abcd9999', 'must return daemonShortId');
  assert.equal(snap.state, 'done', 'must return state');
  assert.equal(snap.detail, 'finished', 'must return detail');
  assert.equal(snap.cwd, '/home/user/project', 'must return cwd');
  assert.equal(snap.output, undefined, 'output must be stripped — sensitive LLM content');
  assert.equal(snap.linkScanPath, undefined, 'linkScanPath must be stripped — internal filesystem path');
});

test('F198-C AC-C4: readAgentSessions handles malformed JSON gracefully', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-sessions-json-test-'));
  const goodJob = join(jobsDir, 'good0001');
  const brokenJob = join(jobsDir, 'broke002');
  mkdirSync(goodJob, { recursive: true });
  mkdirSync(brokenJob, { recursive: true });

  writeFileSync(join(goodJob, 'state.json'), JSON.stringify({ state: 'working', daemonShort: 'good0001' }));
  writeFileSync(join(brokenJob, 'state.json'), '{invalid-json');

  const sessions = await readAgentSessions(jobsDir);
  assert.equal(sessions.length, 1, 'must skip dirs with malformed state.json');
  assert.equal(sessions[0].daemonShortId, 'good0001');
});
