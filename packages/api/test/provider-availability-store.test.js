/**
 * Provider availability snapshot store tests.
 *
 * The snapshot is derived state that is rewritten on the next detection round, so the store
 * must fail soft on anything unreadable and must not rewrite the file when nothing changed.
 * Every test points CAT_CAFE_GLOBAL_CONFIG_ROOT at a temp dir so the live config root is never
 * touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

const { PROVIDERS_SNAPSHOT_VERSION, readProvidersSnapshot, resolveProvidersSnapshotPath, writeProvidersSnapshot } =
  await import('../dist/domains/cats/services/agents/providers/provider-availability-store.js');

let sandbox;
let previousRoot;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'providers-snapshot-'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = sandbox;
});

afterEach(() => {
  if (previousRoot === undefined) {
    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  } else {
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function provider(overrides = {}) {
  return {
    clientId: 'anthropic',
    toolId: 'claude',
    label: 'Claude',
    installed: true,
    command: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    resolvedVia: 'path',
    hasApiKey: false,
    status: 'configured',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    localCli: true,
    ...overrides,
  };
}

function report(providers, detectedAt = new Date().toISOString()) {
  return { detectedAt, versionProbeEnabled: false, providers };
}

test('round-trips a report under .cat-cafe/providers.json', () => {
  const wrote = writeProvidersSnapshot(report([provider(), provider({ clientId: 'kimi', installed: false })]));

  assert.equal(wrote, true);
  const snapshotPath = resolveProvidersSnapshotPath();
  assert.ok(snapshotPath.endsWith(join('.cat-cafe', 'providers.json')));
  assert.ok(snapshotPath.startsWith(sandbox), 'writes stay inside the injected config root');

  const snapshot = readProvidersSnapshot();
  assert.equal(snapshot.version, PROVIDERS_SNAPSHOT_VERSION);
  assert.equal(snapshot.report.providers.length, 2);
  assert.equal(snapshot.report.providers[1].installed, false);
  assert.match(snapshot.note, /safe to delete/i, 'the file tells the reader it is derived state');
});

test('skips the write when nothing material changed', () => {
  const providers = [provider()];
  assert.equal(writeProvidersSnapshot(report(providers, '2026-01-01T00:00:00.000Z')), true);
  // A routine refresh always carries a new detectedAt; only findings decide the write.
  assert.equal(
    writeProvidersSnapshot(report(providers, '2026-01-01T00:05:00.000Z')),
    false,
    'an unchanged finding set must not rewrite the file',
  );
  assert.equal(readProvidersSnapshot().report.detectedAt, '2026-01-01T00:00:00.000Z');
});

test('rewrites when a finding actually changed', () => {
  assert.equal(writeProvidersSnapshot(report([provider()])), true);
  assert.equal(
    writeProvidersSnapshot(report([provider({ installed: false, status: 'missing', resolvedPath: undefined })])),
    true,
  );
  const snapshot = readProvidersSnapshot();
  assert.equal(snapshot.report.providers[0].installed, false);
});

test('a missing snapshot reads as null rather than throwing', () => {
  assert.equal(readProvidersSnapshot(), null);
});

test('a corrupt or foreign snapshot reads as null rather than throwing', () => {
  writeProvidersSnapshot(report([provider()]));
  const snapshotPath = resolveProvidersSnapshotPath();

  writeFileSync(snapshotPath, '{ not json', 'utf-8');
  assert.equal(readProvidersSnapshot(), null, 'a truncated file must not break the startup path');

  writeFileSync(snapshotPath, JSON.stringify({ version: 999, report: { providers: [] } }), 'utf-8');
  assert.equal(readProvidersSnapshot(), null, 'an unknown version is ignored, not partially trusted');

  writeFileSync(snapshotPath, JSON.stringify({ version: PROVIDERS_SNAPSHOT_VERSION }), 'utf-8');
  assert.equal(readProvidersSnapshot(), null, 'a snapshot without a provider list is rejected');

  writeFileSync(snapshotPath, JSON.stringify({ version: PROVIDERS_SNAPSHOT_VERSION, report: {} }), 'utf-8');
  assert.equal(readProvidersSnapshot(), null);
});

test('persists no credentials, only paths and install hints', () => {
  writeProvidersSnapshot(report([provider({ hasApiKey: false })]));
  const raw = readFileSync(resolveProvidersSnapshotPath(), 'utf-8');
  assert.equal(/api[_-]?key\s*[:=]\s*["']?sk-/i.test(raw), false, 'no key material may be persisted');
  assert.equal(JSON.parse(raw).report.providers[0].hasApiKey, false);
});
