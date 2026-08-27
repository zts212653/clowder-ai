import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertProtocolCensus,
  computeProtocolSnapshot,
  runDriftAudit,
  runHermeticCensus,
} from '../scripts/check-codex-app-server-protocol-census.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/codex-app-server-thread-item-types.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/check-codex-app-server-protocol-census.mjs', import.meta.url));

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

test('hermetic census reads only the committed fixture and never shells out', async () => {
  // Regression: the build census must produce identical results regardless of
  // which (or whether any) Codex CLI version is installed on the developer machine.
  // runHermeticCensus reads ONLY the committed fixture; it never shells out to `codex`.

  // Run the script as a subprocess with PATH emptied of codex to prove no child process.
  // If the hermetic path tried to shell out to `codex`, it would fail with ENOENT.
  const result = execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, PATH: '' },
  });
  assert.match(result, /protocol census OK/);
});

test('drift audit fails closed when codex CLI is not installed', async () => {
  // The explicit --drift audit must fail-closed when the codex binary is absent.
  // A silent pass here would hide real drift from the developer.
  // Run as subprocess with empty PATH so `codex` is guaranteed absent.
  assert.throws(
    () =>
      execFileSync(process.execPath, [scriptPath, '--drift'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, PATH: '' },
      }),
    (error) => {
      // Must exit non-zero AND the error message must mention the CLI being absent.
      return error.status !== 0 && /codex CLI is not installed/.test(error.stderr);
    },
  );
});

test('version drift between fixture and live snapshot is caught', async () => {
  const fixture = await loadFixture();
  const mutated = { ...fixture, codexVersion: '0.999.0' };
  assert.throws(
    () => assertProtocolCensus(fixture, computeProtocolSnapshot(mutated)),
    /version drift.*expected=0\.150\.1.*actual=0\.999\.0/,
  );
});

test('unknown CLI arguments are rejected with non-zero exit', async () => {
  // Typos like --update or --driftt must not silently fall back to hermetic mode.
  assert.throws(
    () =>
      execFileSync(process.execPath, [scriptPath, '--bogus'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error) => error.status !== 0,
  );
});
