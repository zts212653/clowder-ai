import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse, stringify } from 'yaml';
import { checkCapabilityTipsEnablementForRepo } from './check-capability-tips-enablement.mjs';
import { rootCheckChain } from './lib/root-check-chain.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const apiDistRoot = resolve(repoRoot, 'packages/api/dist');

describe('F268 production enablement check wiring', () => {
  it('is part of the root pnpm check chain', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

    assert.match(rootCheckChain(packageJson.scripts), /pnpm check:capability-tips-enablement/);
    assert.match(packageJson.scripts['check:capability-tips-enablement'], /check-capability-tips-enablement\.mjs/);
  });

  it('accepts the checked-in disabled registry state', async () => {
    assert.deepEqual(await checkCapabilityTipsEnablementForRepo(repoRoot), { ok: true });
  });

  it('rejects enabled registry state backed by wrong-but-existing files', async (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'f268-enable-gate-'));
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
    for (const directory of [
      'docs/harness-feedback/eval-domains',
      'docs/harness-feedback/registry',
      'docs/harness-feedback/certificates',
      'docs/harness-feedback/replays',
    ]) {
      mkdirSync(resolve(fixtureRoot, directory), { recursive: true });
    }

    const checkedInDomain = readFileSync(
      resolve(repoRoot, 'docs/harness-feedback/eval-domains/eval-capability-tips.yaml'),
      'utf8',
    );
    // Enabling is an explicit revival under the F267 dormancy contract: drop the
    // dormancy block and flip the flag, otherwise the registry fails closed first.
    const revived = parse(checkedInDomain);
    delete revived.dormancy;
    revived.enabled = true;
    const enabledDomain = stringify(revived);
    assert.notEqual(enabledDomain, checkedInDomain);
    writeFileSync(resolve(fixtureRoot, 'docs/harness-feedback/eval-domains/eval-capability-tips.yaml'), enabledDomain);
    writeFileSync(
      resolve(fixtureRoot, 'docs/harness-feedback/registry/eval-capability-tips-enable-gate.yaml'),
      [
        'domainId: eval:capability-tips',
        'f267CertificateRef: docs/harness-feedback/certificates/not-a-certificate.yaml',
        'pipelineReplayRef: docs/harness-feedback/replays/not-a-replay.yaml',
        '',
      ].join('\n'),
    );
    writeFileSync(
      resolve(fixtureRoot, 'docs/harness-feedback/certificates/not-a-certificate.yaml'),
      'domainId: eval:capability-tips\nenabled: false\n',
    );
    writeFileSync(
      resolve(fixtureRoot, 'docs/harness-feedback/replays/not-a-replay.yaml'),
      'domainId: eval:capability-tips\nstatus: passed\n',
    );

    const result = await checkCapabilityTipsEnablementForRepo(fixtureRoot, { apiDistRoot });
    assert.equal(result.ok, false);
    assert.match(result.error, /F267 certificate is not a valid typed evidence artifact/i);
  });
});
