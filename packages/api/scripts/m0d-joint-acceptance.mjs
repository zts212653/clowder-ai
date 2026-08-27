import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  gitOutput,
  gitRepository,
  packageEvidence,
  rebuildHostRuntime,
  reportPackageEvidence,
  verifiedCommit,
  verifyHostProvenance,
  verifyPluginsProvenance,
} from './m0d-acceptance-provenance.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const behaviorFixtureRelativePath = 'fixtures/behavior/messaging/adversarial-invariants.json';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing required ${name}`);
  return value;
}

function requiredSha(name) {
  const value = argumentValue(name);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full lowercase Git SHA`);
  return value;
}

const pluginsRepository = await gitRepository(argumentValue('--plugins-repository'), '--plugins-repository');
const pluginsSha = requiredSha('--plugins-sha');
const hostReviewedSha = requiredSha('--host-reviewed-sha');
const hostMergeSha = requiredSha('--host-merge-sha');
const hostAcceptanceReviewedSha = requiredSha('--host-acceptance-reviewed-sha');
const [hostSha, worktreeStatus] = await Promise.all([
  gitOutput(['rev-parse', 'HEAD'], repositoryRoot),
  gitOutput(['status', '--porcelain'], repositoryRoot),
]);
if (worktreeStatus !== '') {
  throw new Error('joint acceptance evidence requires a clean worktree so executedSha identifies the executed code');
}
await verifiedCommit(pluginsRepository, '--plugins-sha', pluginsSha);
const hostProvenance = await verifyHostProvenance({
  repository: repositoryRoot,
  executedSha: hostSha,
  acceptanceReviewedSha: hostAcceptanceReviewedSha,
  frozenReviewedSha: hostReviewedSha,
  mergeSha: hostMergeSha,
});
const [contract, sdk] = await Promise.all([
  packageEvidence('@clowder-ai/plugin-contract', '@clowder-ai/plugin-contract/conformance'),
  packageEvidence('@clowder-ai/plugin-sdk'),
]);
const fixtureBytes = await readFile(join(contract.root, behaviorFixtureRelativePath));
const pluginsProvenance = await verifyPluginsProvenance({
  repository: pluginsRepository,
  sha: pluginsSha,
  contract,
  sdk,
  fixtureBytes,
});
const hostRuntime = await rebuildHostRuntime(repositoryRoot);
const [rebuiltHostSha, rebuiltWorktreeStatus] = await Promise.all([
  gitOutput(['rev-parse', 'HEAD'], repositoryRoot),
  gitOutput(['status', '--porcelain'], repositoryRoot),
]);
if (rebuiltHostSha !== hostSha || rebuiltWorktreeStatus !== '') {
  throw new Error('Host runtime rebuild changed the executed commit or worktree');
}
const { isM0dAcceptancePassed, runM0dJointAcceptance } = await import('../test/plugin-m0d-joint-runner.js');
const execution = await runM0dJointAcceptance();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  integrity: {
    host: {
      executedSha: hostSha,
      acceptanceReviewedSha: hostAcceptanceReviewedSha,
      reviewedSha: hostReviewedSha,
      mergeSha: hostMergeSha,
      provenance: { ...hostProvenance, runtime: hostRuntime },
    },
    plugins: { frozenSha: pluginsSha, provenance: pluginsProvenance },
    packages: {
      contract: reportPackageEvidence(contract),
      sdk: reportPackageEvidence(sdk),
    },
    behaviorFixture: {
      source: execution.catalog.source,
      digest: `sha256-${createHash('sha256').update(fixtureBytes).digest('hex')}`,
      count: execution.catalog.count,
      catalogMatches: execution.catalog.catalogMatches,
    },
  },
  isolation: {
    runtimeActivation: 'dormant',
    persistentDataStore: 'none',
    reservedPortsUsed: [],
    packageInstallRoot: 'per-case-temporary-directory',
  },
  acceptance: {
    passed: isM0dAcceptancePassed(execution),
    counts: execution.counts,
  },
  nonClaims: [
    'No live Clowder AI runtime was activated.',
    'No real Feishu credential or external message delivery was exercised.',
    'Host-admin cases were classified but not executed through invented stdio methods.',
    'Admission mismatches prove fail-closed behavior, not canonical domain-code conformance.',
  ],
  cases: execution.cases,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.acceptance.passed) process.exitCode = 1;
