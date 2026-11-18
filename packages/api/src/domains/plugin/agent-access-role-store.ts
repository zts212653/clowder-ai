import { createHash } from 'node:crypto';
import { type CatCafeConfig, catRegistry } from '@cat-cafe/shared';
import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessRoleStore,
  agentAccessRoleProfileSchema,
} from '@clowder-ai/agent-contract';
import { readCatCatalogRaw, resolveCatCatalogPath } from '../../config/cat-catalog-store.js';
import {
  loadCatConfig,
  loadResolvedCatConfig,
  parseRawCatConfig,
  toAllCatConfigs,
} from '../../config/cat-config-loader.js';
import { assertCodexMemberMutationReady } from '../../config/codex-account-binding.js';
import { resolveProjectTemplatePath } from '../../config/project-template-path.js';
import {
  findTemplateVariantTombstoneInput,
  refreshRuntimeCatCatalogCaches,
  withRuntimeCatMutationLock,
} from '../../config/runtime-cat-catalog.js';
import { writeFileAtomic } from '../../config/write-file-atomic.js';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';
import {
  type SessionImplementationRef,
  sessionImplementationKey,
} from '../cats/services/agents/session-contract/implementation-registry.js';
import { resolveMemberSessionRef } from '../cats/services/agents/session-contract/plugin-agent-provider.js';
import { currentPluginOwnerRequestContext } from './carrier/plugin-call-context.js';

export const AGENT_PROVIDER_UNAVAILABLE = 'agent_provider_unavailable';
export type DeclaredAgentProviderAvailability = (reference: SessionImplementationRef) => boolean;

function catalogProvider(catalog: CatCafeConfig, catId: string) {
  const cat = toAllCatConfigs(catalog)[catId];
  if (!cat) return;
  if (cat.agentProvider !== undefined || cat.carrier !== 'acp')
    return resolveMemberSessionRef(cat.agentProvider, undefined);
  const variant = catalog.breeds
    .flatMap((breed) => breed.variants.filter((item) => (item.catId ?? breed.catId) === catId))
    .find((item) => 'acp' in item);
  return resolveMemberSessionRef(
    undefined,
    undefined,
    (variant as { acp?: { agentProvider?: string } } | undefined)?.acp?.agentProvider,
  );
}

export function createAgentAccessRoleStore(
  pluginId: string,
  instanceId: string,
  assertActivation: () => void,
  isDeclaredAgentProviderAvailable?: DeclaredAgentProviderAvailability,
): AgentAccessRoleStore | undefined {
  if (pluginId !== AGENT_ACCESS_PLUGIN_ID) return undefined;

  const projectRoot = resolveActiveProjectRoot();
  const path = resolveCatCatalogPath(projectRoot);
  const digest = (source: string) => createHash('sha256').update(source).digest('hex');

  async function authorize(operation: 'read' | 'write') {
    assertActivation();
    const owner = currentPluginOwnerRequestContext(instanceId);
    if (!owner || (operation === 'write' && owner.operation !== 'write'))
      throw new Error('Agent role catalog requires an authenticated request');
    await owner.assertCurrent();
    assertActivation();
    return owner;
  }

  function readCatalogSource() {
    const current = readCatCatalogRaw(projectRoot, { persistMigrations: false });
    if (current === null) throw new Error('Agent role catalog is not initialized');
    return current;
  }

  return {
    async readCatalog() {
      const owner = await authorize('read');
      const source = readCatalogSource();
      const revision = digest(source);
      if (owner.operation === 'write') return { source, revision };
      const resolved = loadResolvedCatConfig(resolveProjectTemplatePath(projectRoot), { persistMigrations: false });
      const profiles = Object.fromEntries(
        Object.entries(toAllCatConfigs(resolved)).map(([id, cat]) => [id, agentAccessRoleProfileSchema.parse(cat)]),
      );
      return { source, revision, profiles };
    },
    async commitCatalog(revision, source, change) {
      return withRuntimeCatMutationLock(projectRoot, async () => {
        await authorize('write');
        const currentSource = readCatalogSource();
        if (digest(currentSource) !== revision) return 'conflict';
        if (change.catId && (change.kind === 'create' || change.kind === 'update')) {
          const previous = change.kind === 'update' ? parseRawCatConfig(currentSource) : undefined;
          const next = parseRawCatConfig(source);
          const selected = catalogProvider(next, change.catId);
          const current = previous && catalogProvider(previous, change.catId);
          if (
            selected &&
            (!current || sessionImplementationKey(selected) !== sessionImplementationKey(current)) &&
            isDeclaredAgentProviderAvailable?.(selected) === false
          )
            throw new Error(AGENT_PROVIDER_UNAVAILABLE);
          assertCodexMemberMutationReady(
            projectRoot,
            next,
            change.catId,
            previous
              ? {
                  cat: toAllCatConfigs(previous)[change.catId],
                  available: previous.version !== 2 || previous.roster[change.catId]?.available !== false,
                }
              : undefined,
            change.requireAccountCheck,
          );
        }
        writeFileAtomic(path, source, { verify: (candidate) => loadCatConfig(candidate) });
        refreshRuntimeCatCatalogCaches();
        return 'committed';
      });
    },
    async readRegisteredAliases() {
      await authorize('write');
      return Object.values(catRegistry.getAllConfigs()).map(({ id, mentionPatterns }) => ({ id, mentionPatterns }));
    },
    async readTemplateTombstone(catId) {
      await authorize('write');
      return findTemplateVariantTombstoneInput(projectRoot, catId);
    },
  };
}
