import { realpathSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PluginManagerConfigureRequest } from '@cat-cafe/shared';
import { allowsAcpBootstrapConfigAuditWarning } from '../../../config/acp-bootstrap-config-audit-policy.js';
import { inspectAcpBootstrapDirectory } from '../../cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';
import {
  parseAgentClientProfiles,
  parseAgentProviderDeclaration,
} from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import { readDeclaration } from '../declared/declared-agent-session-providers.js';
import { resolvePackageFile } from '../declared/declared-resource-paths.js';
import type { VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import { pluginHostRoot } from '../host-inventory/plugin-host-layout.js';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import { readPluginConfig, readPluginConfigText } from '../plugin-config-store.js';
import { type AcpBootstrapIdentityReader, readAcpBootstrapRootIdentity } from './acp-bootstrap-root-identity.js';
import { PluginManagerServiceError } from './plugin-manager-service.js';

function refused(): never {
  throw new PluginManagerServiceError(
    'AUDIT_UNAVAILABLE',
    'Plugin audit log is unavailable; only a verified ACP bootstrap root change can use recovery. 目录可能已创建，本次配置未保存。',
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
      if (oldRoot && win32.resolve(oldRoot).toLowerCase() === win32.resolve(newRoot).toLowerCase()) return refused();
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
  bootstrapIdentity?: AcpBootstrapIdentityReader;
  pluginId: string;
  pluginInstanceId: string;
  request: PluginManagerConfigureRequest;
}): Promise<AcpBootstrapConfigRecovery> {
  if (!allowsAcpBootstrapConfigAuditWarning() || !input.packages) return refused();
  if (
    'path' in input.inventory &&
    typeof input.inventory.path === 'string' &&
    realpathSync.native(dirname(input.inventory.path)).toLowerCase() !==
      realpathSync.native(pluginHostRoot(input.projectRoot)).toLowerCase()
  )
    return refused();
  const captured = await input.inventory.transaction((tx) => {
    const instance = tx.instances.getCurrent(input.pluginId);
    const record = instance && tx.packages.get(instance.packageDigest);
    const grant = instance && tx.grants.get(instance.pluginInstanceId);
    if (
      instance?.pluginInstanceId === input.pluginInstanceId &&
      instance.lifecycleRevision !== input.request.expectedRevision
    )
      throw new PluginManagerServiceError('STALE_REVISION', 'Plugin configuration changed; refresh before retrying');
    if (
      !instance ||
      instance.pluginInstanceId !== input.pluginInstanceId ||
      !record?.manifest ||
      record.packageState !== 'installed' ||
      !grant?.effectiveGrants.includes('plugin.config.read') ||
      !grant.requestedCapabilities.includes('plugin.config.read') ||
      !record.manifest.features.some((feature) => feature.capabilities.includes('plugin.config.read'))
    )
      return refused();
    const text = readPluginConfigText(input.projectRoot, input.pluginId);
    if (text !== undefined) {
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        return refused();
      }
      if (
        !document ||
        typeof document !== 'object' ||
        Array.isArray(document) ||
        Object.entries(document).some(
          ([key, value]) =>
            key === '__proto__' ||
            (typeof value !== 'string' &&
              value !== null &&
              !(key === '_operations' && value && typeof value === 'object' && !Array.isArray(value))),
        )
      )
        return refused();
    }
    return {
      instance,
      record,
      grant,
      stored: readPluginConfig(input.projectRoot, input.pluginId),
      text,
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
    const identity = input.bootstrapIdentity ?? readAcpBootstrapRootIdentity;
    const identities = new Map<string, string>();
    const admission: AcpBootstrapConfigRecovery = {
      async verify() {
        if (!allowsAcpBootstrapConfigAuditWarning()) return refused();
        await located.verifyIntegrity();
        for (const [root, previousRoots] of roots) {
          const targetIdentity = identity(root);
          for (const previous of previousRoots) {
            const oldIdentity = identity(previous, true);
            if (oldIdentity && targetIdentity === oldIdentity) return refused();
          }
          const check = (input.inspectBootstrapRoot ?? inspectAcpBootstrapDirectory)(root);
          if (!check.ok)
            throw new PluginManagerServiceError('INVALID_CONFIGURATION', `引导目录检查失败：${check.error}`);
          if (check.trustMode !== 'trusted-host') return refused();
          const current = identity(root);
          if (!current || (identities.has(root) && identities.get(root) !== current)) return refused();
          identities.set(root, current);
        }
      },
      assertCurrent(tx) {
        for (const [root, expected] of identities) if (identity(root) !== expected) return refused();
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
          !isDeepStrictEqual(tx.grants.get(instance.pluginInstanceId), captured.grant) ||
          readPluginConfigText(input.projectRoot, input.pluginId) !== captured.text ||
          !isDeepStrictEqual(readPluginConfig(input.projectRoot, input.pluginId), captured.stored)
        )
          return refused();
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
