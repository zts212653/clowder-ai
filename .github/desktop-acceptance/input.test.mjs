import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProducer } from './input.mjs';

const head = 'a'.repeat(40);
const input = { runId: '40289777538', head, version: '0.14.0', repository: 'zts212653/clowder-ai' };
const run = {
  id: 40289777538,
  head_sha: head,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  path: '.github/workflows/release-desktop.yml',
  repository: { full_name: input.repository },
};
const artifacts = ['windows-installer-0.14.0', 'windows-portable-0.14.0'].map((name, index) => ({
  id: index + 1,
  name,
  expired: false,
  digest: `sha256:${'b'.repeat(64)}`,
  created_at: '2026-10-26T08:14:00Z',
  workflow_run: { id: run.id, head_sha: head },
}));
const jobs = [
  {
    name: 'Windows Desktop / Windows Installer + Portable',
    run_id: run.id,
    run_attempt: 1,
    head_sha: head,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-26T08:05:00Z',
    completed_at: '2026-10-26T08:15:00Z',
  },
];

test('accepts only the exact successful artifact-only producer and both Windows artifacts', () => {
  assert.equal(validateProducer(input, run, artifacts, jobs).length, 2);
});
for (const [name, changed] of [
  ['different HEAD', { head_sha: 'c'.repeat(40) }],
  ['another repository', { repository: { full_name: 'other/repository' } }],
  ['release event', { event: 'release' }],
  ['different run ID', { id: 1 }],
  ['different workflow', { path: '.github/workflows/other.yml' }],
]) {
  test(`rejects ${name}`, () => assert.throws(() => validateProducer(input, { ...run, ...changed }, artifacts, jobs)));
}
test('rejects missing, duplicate, expired or digest-free artifacts', () => {
  for (const bad of [
    artifacts.slice(1),
    [...artifacts, artifacts[0]],
    [{ ...artifacts[0], expired: true }, artifacts[1]],
    [{ ...artifacts[0], digest: null }, artifacts[1]],
    [{ ...artifacts[0], workflow_run: { id: run.id, head_sha: 'c'.repeat(40) } }, artifacts[1]],
  ]) {
    assert.throws(() => validateProducer(input, run, bad, jobs));
  }
});
test('rejects shell-like or ambiguous producer inputs before any command', () => {
  for (const changed of [
    { runId: '1;whoami' },
    { head: 'main' },
    { version: '0.14.0;whoami' },
    { repository: 'other/repo' },
  ]) {
    assert.throws(() => validateProducer({ ...input, ...changed }, run, artifacts, jobs));
  }
});
test('verifies Windows independently while retaining another platform failure or pending state', () => {
  assert.equal(validateProducer(input, { ...run, conclusion: 'failure' }, artifacts, jobs).length, 2);
  assert.equal(validateProducer(input, { ...run, status: 'in_progress', conclusion: null }, artifacts, jobs).length, 2);
});
test('rejects failed, missing, duplicate or stale Windows producer jobs and older artifacts', () => {
  for (const bad of [
    [],
    [...jobs, jobs[0]],
    [{ ...jobs[0], conclusion: 'failure' }],
    [{ ...jobs[0], run_attempt: 0 }],
    [{ ...jobs[0], head_sha: 'c'.repeat(40) }],
  ])
    assert.throws(() => validateProducer(input, run, artifacts, bad));
  assert.throws(() =>
    validateProducer(input, run, [{ ...artifacts[0], created_at: '2026-10-25T08:14:00Z' }, artifacts[1]], jobs),
  );
});
