import { isDeepStrictEqual } from 'node:util';
import {
  AGENT_PROVIDER_DECLARATION_FILE,
  parseAgentProviderDeclaration,
} from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginAgentClientMetadata } from '../host-inventory/agent-client-metadata.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { LEGACY_BUNDLED_MANIFESTS } from '../legacy-bundled-manifests.js';
import { bundledManifestDigest } from '../official-catalog.js';
import { resolvePackageFile } from './declared-resource-paths.js';
import { readDeclaration } from './read-agent-provider-declaration.js';

/** Installation already holds this verified tree after capability admission.
 * Legacy declaration errors remain visible without granting launch rights. */
export async function readAgentClientMetadata(located: VerifiedPluginPackage): Promise<PluginAgentClientMetadata> {
  await located.verifyIntegrity();
  let raw: unknown;
  try {
    raw = await readDeclaration(
      await resolvePackageFile(located.rootDir, AGENT_PROVIDER_DECLARATION_FILE, 'Agent provider declaration'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: 'ACP 插件声明无效，请检查插件程序包。' };
  }
  await located.verifyIntegrity();
  const result = parseAgentProviderDeclaration(raw, { packageRoot: located.rootDir });
  if (!result.ok) return { error: result.reason };
  const declaration = result.declaration;
  return {
    catalog:
      'id' in declaration
        ? {
            configurationKey: declaration.configurationKey ?? null,
            presets: [],
            clients: [{ id: declaration.id }],
            defaultClient: { id: declaration.id, name: located.manifest.name, ...declaration.acp },
          }
        : { configurationKey: declaration.configurationKey, presets: declaration.presets ?? [], clients: [] },
  };
}

/** Upgrade recovery only. GET never invokes this preparation, and subsequent
 * restarts reuse the digest-bound metadata in the existing inventory. */
export async function recoverAgentClientMetadata(input: {
  inventory: PluginInventoryStore;
  packages: VerifiedPluginPackageLocator;
  onFailure(pluginId: string): void;
}): Promise<void> {
  const snapshot = await input.inventory.snapshot({ currentOnly: true });
  const installed = new Set(
    snapshot.instances
      .filter((instance) => instance.lifecycleState === 'installed')
      .map((instance) => instance.packageDigest),
  );
  for (const record of snapshot.packages.filter(
    (record) => installed.has(record.packageDigest) && record.manifest && record.agentClientMetadata === undefined,
  )) {
    let located: VerifiedPluginPackage | undefined;
    try {
      let metadata: PluginAgentClientMetadata = null;
      const legacy =
        (record.provenance === undefined &&
          record.manifest?.runtime?.transport === 'builtin' &&
          record.manifest.runtime.entrypoint === undefined) ||
        LEGACY_BUNDLED_MANIFESTS.some(
          (manifest) =>
            manifest.pluginId === record.pluginId && bundledManifestDigest(manifest) === record.packageDigest,
        );
      if (!legacy) {
        const staticFile = await input.packages.readInstalledStaticFile?.(
          record.packageDigest,
          () => AGENT_PROVIDER_DECLARATION_FILE,
        );
        if (staticFile && !isDeepStrictEqual(staticFile.manifest, record.manifest))
          throw new Error('ACP package metadata authority mismatch');
        if (!staticFile || staticFile.bytes !== undefined) {
          located = await input.packages.resolveInstalledPackage(record.packageDigest);
          if (!isDeepStrictEqual(located.manifest, record.manifest)) throw new Error('ACP package authority mismatch');
          metadata = await readAgentClientMetadata(located);
        }
      }
      await input.inventory.transaction(async ({ packages }) => {
        const current = await packages.get(record.packageDigest);
        if (
          current &&
          current.agentClientMetadata === undefined &&
          isDeepStrictEqual(current.manifest, record.manifest)
        )
          await packages.put({ ...current, agentClientMetadata: metadata });
      });
    } catch {
      input.onFailure(record.pluginId);
    } finally {
      await located?.release();
    }
  }
}
