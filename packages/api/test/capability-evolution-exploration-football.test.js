import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createMicroduckLocalOwnerBindings } from '../dist/infrastructure/capability-evolution/adapters/microduck-local-owner.js';
import { readExplorationOwner } from '../dist/infrastructure/capability-evolution/read-model/program-exploration.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const programRef = { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68' };
const objectRef = { ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', version: '1' };
const input = { programRef, objectRef };
const owner = (readBytes) => createMicroduckLocalOwnerBindings({ repoRoot, ...(readBytes ? { readBytes } : {}) });

test('football owner exposes immutable public archive groups, preserves v3 repeats and does not invent adopted versions', async () => {
  const result = await readExplorationOwner(owner(), input);
  assert.equal(result.code, 200, JSON.stringify(result.body));
  const archives = result.body.nodes.filter((node) => node.kind === 'public_archive');
  assert.equal(archives.length, 9);
  assert.equal(result.body.experiments.length, 12);
  assert.equal(
    result.body.experiments.reduce((n, run) => n + run.recordCount, 0),
    96,
  );
  const v3 = archives.find((node) => node.title.startsWith('v3'));
  assert.equal(
    result.body.experiments.filter((run) => run.nodeRef.ownerStateRef === v3.nodeRef.ownerStateRef).length,
    3,
  );
  assert(archives.every((node) => !('versionRef' in node)));
  assert.equal('currentVersionRefs' in result.body, false);
});

test('all records come from exact run captures, and v4 right farther is approach contact without a kick', async () => {
  const adapter = owner();
  const catalog = (await readExplorationOwner(adapter, input)).body;
  assert.equal(catalog.status, 'resolved');
  const run = catalog.experiments.find((run) => run.title.includes('20260909-positions-v4'));
  assert(run, 'v4 position run must remain separately selectable');
  const result = await readExplorationOwner(adapter, {
    ...input,
    selectedNodeRef: run.nodeRef,
    selectedExperimentRef: run.experimentRef,
  });
  assert.equal(result.code, 200);
  const detail = result.body.details[0];
  assert.equal(detail.status, 'resolved', JSON.stringify(detail));
  assert.equal(detail.records.length, 6);
  const farther = detail.records.find((record) => record.caseId === 'position-right-farther');
  assert.equal(farther.values.kick_time, null);
  assert.equal(farther.values.foot_contact, 0);
  assert.equal(farther.result.status, 'violated');
  assert.match(farther.result.label, /走近碰球/);
});

test('corrupt source hashes remove the affected record set rather than borrowing another run', async () => {
  const adapter = owner();
  const catalog = (await readExplorationOwner(adapter, input)).body;
  assert.equal(catalog.status, 'resolved');
  const run = catalog.experiments.find((run) => run.title.includes('20260909-positions-v4'));
  const corrupted = owner(async (path) => {
    const bytes = await readFile(path);
    return path.endsWith('.json.gz') && path.includes('20260909-positions-v4') ? Buffer.from('broken capture') : bytes;
  });
  const result = await readExplorationOwner(corrupted, { ...input, selectedExperimentRef: run.experimentRef });
  assert.equal(result.code, 200);
  assert.equal(result.body.details[0].status, 'invalid');
  assert.equal('records' in result.body.details[0], false);
});
