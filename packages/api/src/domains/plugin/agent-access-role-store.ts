import { createHash } from 'node:crypto';
import { AGENT_ACCESS_PLUGIN_ID, type AgentAccessRoleStore } from '@clowder-ai/agent-contract';
import { readCatCatalogRaw, resolveCatCatalogPath } from '../../config/cat-catalog-store.js';
import { loadCatConfig } from '../../config/cat-config-loader.js';
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

  async function authorizeWrite() {
    assertActivation();
    const owner = currentPluginOwnerRequestContext(instanceId);
    if (owner?.operation !== 'write') throw new Error('Agent role catalog requires an authenticated write request');
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
      await authorizeWrite();
      const source = readCatalogSource();
      return { source, revision: digest(source) };
    },
    async commitCatalog(revision, source) {
      return withRuntimeCatMutationLock(projectRoot, async () => {
        await authorizeWrite();
        if (digest(readCatalogSource()) !== revision) return 'conflict';
        writeFileAtomic(path, source, { verify: (candidate) => loadCatConfig(candidate) });
        refreshRuntimeCatCatalogCaches();
        return 'committed';
      });
    },
    async readTemplateTombstone(catId) {
      await authorizeWrite();
      return findTemplateVariantTombstoneInput(projectRoot, catId);
    },
  };
}
