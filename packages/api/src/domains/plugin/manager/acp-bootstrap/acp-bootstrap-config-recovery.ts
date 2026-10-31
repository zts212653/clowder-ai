import { win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PluginManagerConfigureRequest } from '@cat-cafe/shared';
import { allowsAcpBootstrapConfigAuditWarning } from '../../../../config/acp-bootstrap-config-audit-policy.js';
import { inspectAcpBootstrapDirectory } from '../../../cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';
import {
  parseAgentClientProfiles,
  parseAgentProviderDeclaration,
} from '../../../cats/services/agents/session-contract/plugin-agent-provider.js';
import { readDeclaration } from '../../declared/declared-agent-session-providers.js';
import { resolvePackageFile } from '../../declared/declared-resource-paths.js';
import type { VerifiedPluginPackageLocator } from '../../external-runtime/types.js';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../../host-inventory/ports.js';
import { readPluginConfig, readPluginConfigText } from '../../plugin-config-store.js';
import { PluginManagerServiceError } from '../plugin-manager-service.js';
import { acpBootstrapDirectoryIdentity } from './acp-bootstrap-directory-identity.js';

function refused(): never {
  throw new PluginManagerServiceError(
    'AUDIT_UNAVAILABLE',
    'Plugin audit log is unavailable; only a verified ACP bootstrap root change can use recovery. Configuration was not saved; any private directories already created by inspection are retained.',
  );
}

function changedBootstrapRoots(previous: string, nextValue: unknown, packageRoot: string): Map<string, Set<string>> {
  const oldProfiles = parseAgentClientProfiles(previous, { packageRoot });
  const newProfiles = parseAgentClientProfiles(nextValue, { packageRoot });
  if (!oldProfiles.ok || !newProfiles.ok || oldProfiles.profiles.length !== newProfiles.profiles.length)
    return refused();
  const roots = new Map<string, Set<string>>();
  for (let i = 0; i < oldProfiles.profiles.length; i++) {
    const previous = oldProfiles.profiles[i];
    const next = newProfiles.profiles[i];
    if (!previous || !next) return refused();
    const { bootstrapRoot: oldRoot, ...oldAcp } = previous.acp;
    const { bootstrapRoot: newRoot, ...newAcp } = next.acp;
    if (!isDeepStrictEqual({ ...previous, acp: oldAcp }, { ...next, acp: newAcp })) return refused();
    if (oldRoot !== newRoot) {
      if (!newRoot) return refused();
      if (
        oldRoot &&
        win32
          .resolve(oldRoot)
          .replace(/[\\/]+$/, '')
          .toLowerCase() ===
          win32
            .resolve(newRoot)
            .replace(/[\\/]+$/, '')
            .toLowerCase()
      )
        return refused();
      const previousRoots = roots.get(newRoot) ?? new Set<string>();
      if (oldRoot) previousRoots.add(oldRoot);
      roots.set(newRoot, previousRoots);
    }
  }
  if (!roots.size) return refused();
  return roots;
}

export interface AcpBootstrapConfigRecovery {
  verify(): Promise<void>;
  assertCurrent(transaction: PluginInventoryTransaction): void;
  release(): Promise<void>;
}

/** Admission is prepared inside the lifecycle queue, then consumed at the write transaction. */
export async function prepareAcpBootstrapConfigRecovery(input: {
  projectRoot: string;
  inventory: PluginInventoryStore;
  packages?: VerifiedPluginPackageLocator;
  inspectBootstrapRoot?: typeof inspectAcpBootstrapDirectory;
  bootstrapDirectoryIdentity?: typeof acpBootstrapDirectoryIdentity;
  pluginId: string;
  pluginInstanceId: string;
  request: PluginManagerConfigureRequest;
}): Promise<AcpBootstrapConfigRecovery> {
  if (!allowsAcpBootstrapConfigAuditWarning() || !input.packages) return refused();
  const captured = await input.inventory.transaction((tx) => {
    const instance = tx.instances.getCurrent(input.pluginId);
    const record = instance && tx.packages.get(instance.packageDigest);
    if (
      instance?.pluginInstanceId === input.pluginInstanceId &&
      instance.lifecycleRevision !== input.request.expectedRevision
    )
      throw new PluginManagerServiceError('STALE_REVISION', 'Plugin configuration changed; refresh before retrying');
    if (
      !instance ||
      instance.pluginInstanceId !== input.pluginInstanceId ||
      !record?.manifest ||
      record.packageState !== 'installed'
    )
      return refused();
    return {
      instance,
      record,
      stored: readPluginConfig(input.projectRoot, input.pluginId),
      text: readPluginConfigText(input.projectRoot, input.pluginId),
    };
  });
  const located = await input.packages.resolveInstalledPackage(captured.record.packageDigest);
  try {
    if (!isDeepStrictEqual(located.manifest, captured.record.manifest)) return refused();
    await located.verifyIntegrity();
    const declaration = parseAgentProviderDeclaration(
      await readDeclaration(
        await resolvePackageFile(located.rootDir, 'agent-provider.json', 'Agent provider declaration'),
      ),
      { packageRoot: located.rootDir },
    );
    await located.verifyIntegrity();
    if (!declaration.ok || !('configurationKey' in declaration.declaration)) return refused();
    const key = declaration.declaration.configurationKey;
    const field = located.manifest.configuration?.find((field) => field.key === key);
    if (field?.kind !== 'string' || input.request.updates.length !== 1 || input.request.updates[0]?.key !== key)
      return refused();
    const roots = changedBootstrapRoots(
      captured.stored[key] ?? field.default ?? '[]',
      input.request.updates[0].value,
      located.rootDir,
    );
    const identities = new Map<string, string>();
    const identity = input.bootstrapDirectoryIdentity ?? acpBootstrapDirectoryIdentity;
    const readIdentity = (root: string) => {
      try {
        return identity(root);
      } catch {
        return refused();
      }
    };
    const admission: AcpBootstrapConfigRecovery = {
      async verify() {
        if (!allowsAcpBootstrapConfigAuditWarning()) return refused();
        await located.verifyIntegrity();
        for (const [root, oldRoots] of roots) {
          const check = (input.inspectBootstrapRoot ?? inspectAcpBootstrapDirectory)(root);
          if (!check.ok)
            throw new PluginManagerServiceError(
              'INVALID_CONFIGURATION',
              `引导目录检查失败：${check.error}\n检查可能已创建专用目录；本次配置未保存。`,
            );
          if (check.trustMode !== 'trusted-host') return refused();
          const current = readIdentity(root);
          if (!current || [...oldRoots].some((oldRoot) => readIdentity(oldRoot) === current)) return refused();
          if (identities.has(root) && identities.get(root) !== current) return refused();
          identities.set(root, current);
        }
      },
      assertCurrent(tx) {
        const instance = tx.instances.getCurrent(input.pluginId);
        // The lifecycle service alone supplies any internal suspend revision. The normal
        // configuration fence independently checks it immediately before this assertion.
        if (
          !instance ||
          instance.pluginInstanceId !== captured.instance.pluginInstanceId ||
          instance.lifecycleState !== 'installed' ||
          instance.packageDigest !== captured.instance.packageDigest ||
          instance.activationState !== captured.instance.activationState ||
          !isDeepStrictEqual(tx.packages.get(instance.packageDigest), captured.record) ||
          readPluginConfigText(input.projectRoot, input.pluginId) !== captured.text ||
          !isDeepStrictEqual(readPluginConfig(input.projectRoot, input.pluginId), captured.stored)
        )
          return refused();
        for (const [root, expected] of identities) if (readIdentity(root) !== expected) return refused();
      },
      release: () => located.release(),
    };
    await admission.verify();
    return admission;
  } catch (error) {
    await located.release();
    throw error;
  }
}
