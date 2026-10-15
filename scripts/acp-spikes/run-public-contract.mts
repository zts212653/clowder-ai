import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AcpClient } from '../../packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { createAcpPoolSpawnSignature } from '../../packages/api/src/domains/cats/services/agents/providers/acp/acp-pool-signature.js';

// The caller supplies an already-authorized isolated profile. This runner never reads real auth.
if (process.env.CLOWDER_SPIKE_AUTHORIZED !== '1')
  throw new Error('Explicit bounded native-test authorization required');
const provider = process.env.CLOWDER_W2_PROVIDER;
if (provider !== 'claude' && provider !== 'codex') throw new Error('Choose claude or codex');
const runId = process.env.CLOWDER_SPIKE_RUN_ID;
if (!runId || !/^[a-z0-9_-]{1,48}$/.test(runId)) throw new Error('Provide a fresh evidence run ID');
const bridge = resolve(process.env.CLOWDER_W2_BRIDGE ?? '');
const fixture = resolve(process.env.CLOWDER_W2_FIXTURE ?? '');
const native = resolve(process.env.CLOWDER_W2_NATIVE ?? '');
const dir = resolve('.cat-cafe/tmp/w2-public-native', runId);
await mkdir(resolve('.cat-cafe/tmp/w2-public-native'), { recursive: true });
await mkdir(dir); // Never overwrite a failed/in-progress sample.
const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const sources = [
  bridge,
  native,
  'scripts/acp-spikes/run-public-contract.mts',
  'packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.ts',
  'packages/api/src/domains/cats/services/agents/providers/acp/protocol/acp-session-contract.ts',
];
await writeFile(
  join(dir, 'before.json'),
  JSON.stringify(
    {
      provider,
      production: false,
      modelPrompts: 0,
      sources: await Promise.all(sources.map(async (path) => ({ path, sha256: await sha(path) }))),
    },
    null,
    2,
  ),
);
const env: Record<string, string> = {
  ...(provider === 'claude' ? { CLOWDER_IMAGE_UI_ROOT: resolve(fixture, '..') } : {}),
};
const client = new AcpClient({
  command: process.execPath,
  args: [bridge],
  cwd: fixture,
  env,
  permissionHandler: (_request, respond) => respond({ cancelled: true }),
  launchBindingFingerprint: createAcpPoolSpawnSignature({
    command: process.execPath,
    args: [bridge],
    cwd: fixture,
    env,
    idleTtlMs: 1,
    maxLiveProcesses: 1,
  }),
});
const watchdog = setTimeout(() => {
  void client.close();
}, 45_000);
const outcome: Record<string, unknown> = { provider, production: false, modelPrompts: 0 };
try {
  const initialized = await client.initialize();
  outcome.protocolVersion = initialized.protocolVersion;
  outcome.capabilities = client.capabilityProvenance();
  await assert.rejects(
    client.newSession(fixture, [], {
      instructions: {
        revision: 'synthetic-r1',
        entries: [{ role: 'system', content: 'Synthetic required native instruction' }],
      },
    }),
    /unsupported|instruction|role/i,
  );
  outcome.requiredInstructions = 'unsupported_before_session';
  const session = await client.newSession(fixture);
  const option = session.configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model');
  const requested = typeof option?.currentValue === 'string' ? option.currentValue : session.models?.currentModelId;
  outcome.model = requested
    ? await client.applyModelConfig(session.sessionId, requested, session)
    : { effectiveModel: 'unknown', servedModel: 'unknown', source: 'unsupported' };
  await assert.rejects(client.readExecutionBinding(session.sessionId), /negotiated|execution/i);
  outcome.executionBinding = 'unnegotiated_no_probe';
  if (initialized.agentCapabilities.sessionCapabilities?.close) {
    await client.closeSession(session.sessionId);
    outcome.close = 'native_rpc_acknowledged';
  } else {
    await assert.rejects(client.closeSession(session.sessionId), /close|negotiated/);
    outcome.close = 'unsupported_no_probe';
  }
  outcome.status = 'pass_public_contract_support_detection';
} catch (error) {
  outcome.status = 'failed';
  outcome.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  clearTimeout(watchdog);
  await client.close();
  outcome.sourcesAfter = await Promise.all(sources.map(async (path) => ({ path, sha256: await sha(path) })));
  await writeFile(join(dir, 'result.json'), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify({ provider, status: outcome.status, modelPrompts: 0, evidence: dir }));
}
