/**
 * F213 Phase A — DEPRECATED_MANAGED_SERVERS registry + isOurOwnedDeprecatedEntry
 * helper unit tests.
 *
 * 10 cases cover the marker matching contract that protects users from third-party
 * `cat-cafe` entries being incorrectly removed by L5 startup cleanup.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  DEPRECATED_MANAGED_SERVERS,
  isOurOwnedDeprecatedEntry,
} from '../dist/config/capabilities/deprecated-managed-servers.js';

test('DEPRECATED_MANAGED_SERVERS contains cat-cafe entry with only echoLegacyShim marker (argsSuffix removed for safety)', () => {
  const catCafe = DEPRECATED_MANAGED_SERVERS.find((d) => d.serverName === 'cat-cafe');
  assert.ok(catCafe, 'cat-cafe must be registered as deprecated');
  assert.ok(catCafe.reason.includes('F193 Phase C'), 'reason must reference F193 Phase C');
  const markerKinds = catCafe.knownManagedMarkers.map((m) => m.kind);
  // F213 砚砚 review 2026-05-26 P1: argsSuffix marker removed — fork paths
  // (e.g. /path/to/project/...) would falsely match, violating
  // third-party preservation contract. Only specific echoLegacyShim shape
  // (echo + legacy-shim) is reliable enough to commit to deletion.
  assert.ok(!markerKinds.includes('argsSuffix'), 'argsSuffix marker must be removed for safety');
  assert.ok(markerKinds.includes('echoLegacyShim'), 'must have echoLegacyShim marker');
  assert.equal(markerKinds.length, 1, 'only echoLegacyShim marker should remain');
});

test('isOurOwnedDeprecatedEntry: preserves entry matching previous argsSuffix pattern (user fork should not be misidentified)', () => {
  // F213 砚砚 P1 regression guard: this exact entry would have been falsely
  // marked as ours-owned under the old argsSuffix marker, but a user fork at
  // /path/to/project/... legitimately has this shape. Must preserve.
  const entry = {
    command: 'node',
    args: ['/path/to/project/packages/mcp-server/dist/index.js'],
    enabled: true,
  };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), false);
});

test('isOurOwnedDeprecatedEntry: preserves Windows-path entry (no longer matches now that argsSuffix removed)', () => {
  const entry = {
    command: 'node',
    args: ['C:\\Users\\foo\\cat-cafe\\packages\\mcp-server\\dist\\index.js'],
    enabled: true,
  };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), false);
});

test('isOurOwnedDeprecatedEntry: matches echoLegacyShim workaround', () => {
  const entry = { command: 'echo', args: ['legacy-shim'], enabled: false };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), true);
});

test('isOurOwnedDeprecatedEntry: preserves third-party cat-cafe entry (unknown binary)', () => {
  const entry = {
    command: '/usr/local/bin/my-custom-cat-cafe-server',
    args: ['/opt/third-party/cat-cafe-clone.js'],
    enabled: true,
  };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), false);
});

test('isOurOwnedDeprecatedEntry: preserves entry with missing args field', () => {
  const entry = { command: 'node', enabled: true };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), false);
});

test('isOurOwnedDeprecatedEntry: preserves entry with non-array args', () => {
  const entry = { command: 'node', args: 'not-an-array', enabled: true };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), false);
});

test('isOurOwnedDeprecatedEntry: preserves entry with non-string args[0]', () => {
  const entry = { command: 'node', args: [42], enabled: true };
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', entry), false);
});

test('isOurOwnedDeprecatedEntry: returns false for unregistered serverName', () => {
  const entry = { command: 'node', args: ['/foo/bar/packages/mcp-server/dist/index.js'] };
  assert.equal(isOurOwnedDeprecatedEntry('some-other-server', entry), false);
});

test('isOurOwnedDeprecatedEntry: returns false for null entry (defensive)', () => {
  assert.equal(isOurOwnedDeprecatedEntry('cat-cafe', null), false);
});
