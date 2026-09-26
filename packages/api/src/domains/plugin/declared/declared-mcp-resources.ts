import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import type { CapabilityEntry } from '@cat-cafe/shared';
import type { ConfigurationField, McpContribution } from '@clowder-ai/plugin-contract';
import { installMcpCapability, removeMcpCapability } from '../../../config/capabilities/capability-mcp-service.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { packageDirectoryName } from '../external-runtime/filesystem-package-locator.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { effectivePluginConfigurationValue } from '../manager/plugin-configuration-values.js';
import { pluginResourceRoot, resolvePackageFile } from './declared-resource-paths.js';
import type { DeclaredStaticResourceHost } from './declared-static-resources.js';

const MCP_MARKER = '.clowder-mcp-resource.json';
const MCP_MATERIALIZATION_VERSION = 3;

export async function activateDeclaredMcp(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost | undefined,
): Promise<void> {
  const contributions = (admission.packageRecord.manifest.contributions ?? []).filter(
    (contribution): contribution is McpContribution => contribution.type === 'mcp',
  );
  if (contributions.length === 0) return;
  if (!host) {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host static-resource activation is unavailable');
  }
  if (!host.mcpConfigIO) {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host MCP capability activation is unavailable');
  }
  if (contributions.some((contribution) => contribution.runtime.transport !== 'stdio')) {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Only stdio MCP contributions are supported');
  }

  const packageRoot = await stablePackageRoot(admission, host, contributions);
  const installed: string[] = [];
  try {
    for (const contribution of contributions) {
      const entry = await mcpCapability(admission, host, packageRoot, contribution);
      await installMcpCapability(host.projectRoot, entry, host.mcpConfigIO, {
        userId: `plugin:${admission.packageRecord.pluginId}`,
      });
      installed.push(entry.id);
    }
  } catch (error) {
    await Promise.allSettled(installed.map((id) => removeMcp(admission.packageRecord.pluginId, id, host)));
    throw error;
  }
}

export async function removeDeclaredMcp(pluginId: string, host: DeclaredStaticResourceHost | undefined): Promise<void> {
  if (!host) return;
  if (!host.mcpConfigIO) return;
  const config = await host.mcpConfigIO.readConfig();
  const owned = config?.capabilities.filter(
    (capability) => capability.type === 'mcp' && capability.pluginId === pluginId,
  );
  const results = await Promise.allSettled((owned ?? []).map((capability) => removeMcp(pluginId, capability.id, host)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function removeMcp(pluginId: string, capabilityId: string, host: DeclaredStaticResourceHost): Promise<void> {
  if (!host.mcpConfigIO) return;
  await removeMcpCapability(host.projectRoot, capabilityId, host.mcpConfigIO, {
    hard: true,
    pluginId,
    userId: `plugin:${pluginId}`,
  });
}

async function stablePackageRoot(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost,
  contributions: readonly McpContribution[],
): Promise<string> {
  const packageName = admission.packageRecord.provenance?.packageName;
  if (packageName !== undefined && host.mcpPackages !== undefined) {
    const provenance = admission.packageRecord.provenance;
    if (provenance === undefined) throw new Error('package provenance is required when packageName is present');
    const materialized = await host.mcpPackages.resolve({
      pluginInstanceId: admission.instance.pluginInstanceId,
      pluginId: admission.packageRecord.pluginId,
      packageDigest: admission.packageRecord.packageDigest,
      packageName,
      sourceKind: provenance.kind,
    });
    try {
      if (!isDeepStrictEqual(materialized.manifest, admission.packageRecord.manifest)) {
        throw new ExternalPluginRuntimeError(
          'PACKAGE_AUTHORITY_MISMATCH',
          'materialized package manifest differs from the admitted package record',
        );
      }
      await materialized.verifyIntegrity();
      return await materializeMcpPackage(host, admission, materialized.rootDir, contributions, {
        ...(materialized.dependencyRoot === undefined ? {} : { dependencyRoot: materialized.dependencyRoot }),
      });
    } finally {
      await materialized.release();
    }
  }
  const located = await host.packages.resolveInstalledPackage(admission.packageRecord.packageDigest);
  try {
    if (!isDeepStrictEqual(located.manifest, admission.packageRecord.manifest)) {
      throw new ExternalPluginRuntimeError(
        'PACKAGE_AUTHORITY_MISMATCH',
        'located package manifest differs from the admitted package record',
      );
    }
    await located.verifyIntegrity();
    return await materializeMcpPackage(host, admission, located.rootDir, contributions);
  } finally {
    await located.release();
  }
}

async function mcpCapability(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost,
  packageRoot: string,
  contribution: McpContribution,
): Promise<CapabilityEntry> {
  const entrypoint = await resolvePackageFile(packageRoot, contribution.runtime.entrypoint, 'MCP entrypoint');
  return {
    id: `plugin:${admission.packageRecord.pluginId}:${contribution.id}`,
    type: 'mcp',
    enabled: true,
    source: 'plugin',
    pluginId: admission.packageRecord.pluginId,
    mcpServer: {
      command: process.execPath,
      args: [entrypoint, ...(contribution.runtime.args ?? [])],
      transport: 'stdio',
      workingDir: packageRoot,
      ...(await mcpEnvironment(admission, host, contribution)),
    },
  };
}

async function materializeMcpPackage(
  host: DeclaredStaticResourceHost,
  admission: PluginRuntimeAdmission,
  packageRoot: string,
  contributions: readonly McpContribution[],
  options: { readonly dependencyRoot?: string } = {},
): Promise<string> {
  const pluginRoot = pluginResourceRoot(host, admission.packageRecord.pluginId);
  const digestRoot = resolve(pluginRoot, packageDirectoryName(admission.packageRecord.packageDigest));
  const stableRoot = resolve(digestRoot, `mcp-package-v${MCP_MATERIALIZATION_VERSION}`);
  if (await validMcpMaterialization(stableRoot, admission, contributions)) return stableRoot;

  await mkdir(digestRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(resolve(pluginRoot, '.materialize-mcp-'));
  try {
    const target = resolve(temporary, 'package');
    await cp(packageRoot, target, { recursive: true, force: false, errorOnExist: true });
    if (options.dependencyRoot !== undefined && (await directoryExists(options.dependencyRoot))) {
      await cp(options.dependencyRoot, resolve(target, 'node_modules'), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    await writeFile(
      resolve(target, MCP_MARKER),
      `${JSON.stringify({
        pluginId: admission.packageRecord.pluginId,
        packageDigest: admission.packageRecord.packageDigest,
        materializationVersion: MCP_MATERIALIZATION_VERSION,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    for (const contribution of contributions) {
      await resolvePackageFile(target, contribution.runtime.entrypoint, 'MCP entrypoint');
    }
    try {
      await rename(target, stableRoot);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      if (!(await validMcpMaterialization(stableRoot, admission, contributions))) throw error;
    }
    return stableRoot;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validMcpMaterialization(
  root: string,
  admission: PluginRuntimeAdmission,
  contributions: readonly McpContribution[],
): Promise<boolean> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(resolve(root, MCP_MARKER), 'utf8')) as Record<string, unknown>;
    if (!validMarker(marker, admission)) return false;
    for (const contribution of contributions) {
      await resolvePackageFile(root, contribution.runtime.entrypoint, 'MCP entrypoint');
    }
    return true;
  } catch {
    return false;
  }
}

function validMarker(marker: Record<string, unknown>, admission: PluginRuntimeAdmission): boolean {
  return (
    marker.pluginId === admission.packageRecord.pluginId &&
    marker.packageDigest === admission.packageRecord.packageDigest &&
    marker.materializationVersion === MCP_MATERIALIZATION_VERSION &&
    Object.keys(marker).length === 3
  );
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    return value.isDirectory() && !value.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function mcpEnvironment(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost,
  contribution: McpContribution,
): Promise<{ readonly env?: Readonly<Record<string, string>> }> {
  const fields = new Map((admission.packageRecord.manifest.configuration ?? []).map((field) => [field.key, field]));
  const envEntries = await Promise.all(
    Object.entries(contribution.environment ?? {}).map(async ([name, binding]) => {
      const field = fields.get(binding.key);
      const value = await environmentValue(admission, host, contribution, field, binding);
      return value === undefined ? undefined : ([name, value] as const);
    }),
  );
  const env = Object.fromEntries(envEntries.filter((entry): entry is readonly [string, string] => entry !== undefined));
  return Object.keys(env).length === 0 ? {} : { env };
}

async function environmentValue(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost,
  contribution: McpContribution,
  field: ConfigurationField | undefined,
  binding: { readonly source: 'config' | 'secret'; readonly key: string },
): Promise<string | undefined> {
  const grant = binding.source === 'secret' ? 'secret.read' : 'plugin.config.read';
  if (!admission.effectiveGrants.includes(grant)) {
    throw new ExternalPluginRuntimeError(
      'CONFIG_UNAVAILABLE',
      `MCP contribution ${contribution.id} lacks Host grant ${grant}`,
    );
  }
  const raw =
    binding.source === 'secret'
      ? await host.configuration.readSecret(admission.instance.pluginInstanceId, binding.key)
      : await host.configuration.readConfig(admission.instance.pluginInstanceId, binding.key);
  const value = field ? effectivePluginConfigurationValue(field, raw) : undefined;
  if ((value === undefined || value.length === 0) && field?.required) {
    throw new ExternalPluginRuntimeError(
      'CONFIG_UNAVAILABLE',
      `required ${binding.source} ${binding.key} is unavailable`,
    );
  }
  return value || undefined;
}
