import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertProtocolCensus,
  computeProtocolSnapshot,
  runHermeticCensus,
} from '../scripts/check-codex-app-server-protocol-census.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/codex-app-server-thread-item-types.json', import.meta.url));

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

test('pins Codex 0.150.1 stable/experimental method census and complete stable dispositions', async () => {
  const fixture = await loadFixture();

  assert.equal(fixture.codexVersion, '0.150.1');
  assert.deepEqual(fixture.stable.counts, {
    clientRequests: 95,
    serverNotifications: 79,
    serverRequests: 10,
  });
  assert.deepEqual(fixture.experimental.counts, {
    clientRequests: 153,
    serverNotifications: 79,
    serverRequests: 11,
  });

  for (const surface of ['clientRequests', 'serverNotifications', 'serverRequests']) {
    assert.equal(fixture.stable.methods[surface].length, fixture.stable.counts[surface]);
    assert.equal(
      fixture.stable.methods[surface].every(
        (entry) =>
          typeof entry.method === 'string' &&
          typeof entry.disposition === 'string' &&
          typeof entry.owner === 'string' &&
          typeof entry.maturity === 'string' &&
          typeof entry.validationRef === 'string',
      ),
      true,
      `${surface} must record method/disposition/owner/maturity/validationRef`,
    );
  }

  assert.doesNotThrow(() => assertProtocolCensus(fixture, computeProtocolSnapshot(fixture)));
});

test('fails loud on stable method add/delete/rename and experimental delta drift', async () => {
  const fixture = await loadFixture();
  const installed = computeProtocolSnapshot(fixture);
  installed.stable.methods.clientRequests = installed.stable.methods.clientRequests.slice(1);
  installed.stable.methods.clientRequests.push('future/stableMethod');

  assert.throws(() => assertProtocolCensus(fixture, installed), /stable\.clientRequests.*missing=.*unknown=/);

  const deltaDrift = computeProtocolSnapshot(fixture);
  deltaDrift.experimental.methods.serverRequests.push('future/experimentalRequest');
  assert.throws(() => assertProtocolCensus(fixture, deltaDrift), /experimental\.serverRequests.*unknown=/);
});

test('hermetic census uses only the repo-pinned fixture — no ambient CLI dependency', async () => {
  // Regression: the build census must produce identical results regardless of
  // which (or whether any) Codex CLI version is installed on the developer machine.
  // runHermeticCensus reads ONLY the committed fixture; it never shells out to `codex`.
  // If it did, this test would be flaky across machines with different CLI versions.
  assert.doesNotThrow(() => runHermeticCensus());
});

test('version drift between fixture and live snapshot is caught', async () => {
  const fixture = await loadFixture();
  const mutated = { ...fixture, codexVersion: '0.999.0' };
  assert.throws(
    () => assertProtocolCensus(fixture, computeProtocolSnapshot(mutated)),
    /version drift.*expected=0\.150\.1.*actual=0\.999\.0/,
  );
});
