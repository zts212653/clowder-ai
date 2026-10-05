import './setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { _resetDossierCache } from '@cat-cafe/shared/dossier';

export const { createRoutingContextRuntime } = await import(
  '../../dist/domains/routing-context/RoutingContextRuntime.js'
);
export const ownerId = 'issue-1438-owner';
export const primaryCatId = 'issue-1438-primary';
export const secondaryCatId = 'issue-1438-secondary';
export const missingModelCatId = 'issue-1438-missing-model';
const member = (id, defaultModel = 'test-model') => ({
  id,
  name: id,
  displayName: id,
  avatar: 'test',
  color: { primary: '#000', secondary: '#fff' },
  mentionPatterns: [],
  mcpSupport: false,
  roleDescription: 'Local test member',
  personality: 'test',
  clientId: 'openai',
  defaultModel,
});
const configs = {
  [primaryCatId]: member(primaryCatId),
  [secondaryCatId]: member(secondaryCatId),
};
for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
catRegistry.register(missingModelCatId, { ...member(missingModelCatId), defaultModel: undefined });

export function fixture(t, { signals = [], preferences = [], members = configs } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'routing-composition-1438-'));
  t.after(() => {
    _resetDossierCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  const runtime = createRoutingContextRuntime({ redis: {}, projectRoot, getConfigs: () => members });
  // Keep the production catalog/resolver/profile/preflight wiring; isolate only storage I/O.
  t.mock.method(runtime.signalStore, 'getOwnerRevision', async () => signals.length);
  t.mock.method(runtime.signalStore, 'listByOwner', async () => signals);
  t.mock.method(runtime.preferenceStore, 'listByOwner', async () => preferences);
  return { runtime, projectRoot };
}

export function writeDossier(projectRoot, content) {
  const directory = join(projectRoot, 'docs', 'team');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'cat-dossier.md');
  writeFileSync(path, content);
  return path;
}

export function profile(catId) {
  return `# Local dossier\n\n\`\`\`yaml\n# structured-profile: cat:${catId}\nentityId: "cat:${catId}"\noneLiner: "Local member"\n\`\`\`\n`;
}

export async function assertDegraded(runtime, reason, targetCatId = primaryCatId) {
  const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
  assert.equal(read.resolution.state, 'degraded');
  assert.equal(read.resolution.reason, reason);
  const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [targetCatId] });
  assert.equal(decision.resolverState, 'degraded');
  assert.equal(decision.targets[0].disposition, 'warned');
  assert.equal(decision.targets[0].reasons[0].code, 'routing_context_unavailable');
  assert.deepEqual(decision.targets[0].reasons[0].sourceRefs, [`routing-context:resolver_degraded:${reason}`]);
}
