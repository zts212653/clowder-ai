import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertProtocolCensus, computeProtocolSnapshot } from '../scripts/check-codex-app-server-protocol-census.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/codex-app-server-thread-item-types.json', import.meta.url));

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

test('pins Codex 0.149.1 stable/experimental method census and complete stable dispositions', async () => {
  const fixture = await loadFixture();

  assert.equal(fixture.codexVersion, '0.149.1');
  assert.deepEqual(fixture.stable.counts, {
    clientRequests: 95,
    serverNotifications: 75,
    serverRequests: 10,
  });
  assert.deepEqual(fixture.experimental.counts, {
    clientRequests: 150,
    serverNotifications: 75,
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
