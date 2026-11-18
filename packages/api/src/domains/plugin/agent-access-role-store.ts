import { createHash } from 'node:crypto';
import { catRegistry } from '@cat-cafe/shared';
import { AGENT_ACCESS_PLUGIN_ID, type AgentAccessRoleStore } from '@clowder-ai/agent-contract';
import { readCatCatalogRaw, resolveCatCatalogPath } from '../../config/cat-catalog-store.js';
import { loadCatConfig, parseRawCatConfig, toAllCatConfigs } from '../../config/cat-config-loader.js';
import { assertCodexMemberMutationReady } from '../../config/codex-account-binding.js';
import {
  findTemplateVariantTombstoneInput,
  refreshRuntimeCatCatalogCaches,
  withRuntimeCatMutationLock,
} from '../../config/runtime-cat-catalog.js';
import { writeFileAtomic } from '../../config/write-file-atomic.js';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';
import { currentPluginOwnerRequestContext } from './carrier/plugin-call-context.js';

export function createAgentAccessRoleStore(
  pluginId: string,
  instanceId: string,
  assertActivation: () => void,
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
  }

  function readCatalogSource() {
    const current = readCatCatalogRaw(projectRoot, { persistMigrations: false });
    if (current === null) throw new Error('Agent role catalog is not initialized');
    return current;
  }

  return {
    async readCatalog() {
      await authorize('read');
      const source = readCatalogSource();
      return { source, revision: digest(source) };
    },
    async commitCatalog(revision, source, change) {
      return withRuntimeCatMutationLock(projectRoot, async () => {
        await authorize('write');
        const currentSource = readCatalogSource();
        if (digest(currentSource) !== revision) return 'conflict';
        if (change.catId && (change.kind === 'create' || change.kind === 'update')) {
          const previous = change.kind === 'update' ? parseRawCatConfig(currentSource) : undefined;
          assertCodexMemberMutationReady(
            projectRoot,
            parseRawCatConfig(source),
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
