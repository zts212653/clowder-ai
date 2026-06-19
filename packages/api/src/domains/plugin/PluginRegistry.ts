import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CapabilitiesConfig,
  PluginInfo,
  PluginManifest,
  PluginResourceStatus,
  PluginStatus,
} from '@cat-cafe/shared';
import { BUILTIN_PLUGIN_IDS, parsePluginManifest, validateEnvSafety } from './plugin-manifest.js';

function maskValue(raw: string | undefined, sensitive: boolean): string | null {
  if (!raw) return null;
  if (sensitive) return '••••••';
  if (raw.length <= 6) return raw;
  return `${raw.slice(0, 6)}****`;
}

export class PluginRegistry {
  private manifests = new Map<string, PluginManifest>();
  private readonly pluginsDir: string;

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir;
  }

  scan(): PluginManifest[] {
    this.manifests.clear();

    if (!existsSync(this.pluginsDir)) return [];

    const envClaims = new Map<string, string>();
    const candidates: { id: string; manifest: PluginManifest; yamlPath: string }[] = [];

    let entries: string[];
    try {
      entries = readdirSync(this.pluginsDir).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }

    for (const entry of entries) {
      const pluginDir = join(this.pluginsDir, entry);
      try {
        if (!lstatSync(pluginDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const yamlPath = join(pluginDir, 'plugin.yaml');
      if (!existsSync(yamlPath)) continue;

      try {
        const manifest = parsePluginManifest(yamlPath);
        if (manifest.id !== entry) {
          console.warn(`[PluginRegistry] skip ${entry}: manifest id '${manifest.id}' does not match directory name`);
          continue;
        }
        if (BUILTIN_PLUGIN_IDS.has(manifest.id)) {
          console.warn(`[PluginRegistry] skip ${entry}: '${manifest.id}' is a reserved builtin plugin id`);
          continue;
        }
        candidates.push({ id: manifest.id, manifest, yamlPath });
      } catch (err) {
        console.warn(`[PluginRegistry] skip ${entry}: ${(err as Error).message}`);
      }
    }

    candidates.sort((a, b) => a.id.localeCompare(b.id));
    for (const { id, manifest, yamlPath } of candidates) {
      const safety = validateEnvSafety(manifest, envClaims);
      if (!safety.ok) {
        console.warn(`[PluginRegistry] skip ${id} (${yamlPath}): env safety: ${safety.errors.join('; ')}`);
        continue;
      }

      for (const field of manifest.config) {
        envClaims.set(field.envName, id);
      }
      this.manifests.set(id, manifest);
    }

    return [...this.manifests.values()];
  }

  getManifest(pluginId: string): PluginManifest | undefined {
    return this.manifests.get(pluginId);
  }

  getAllManifests(): PluginManifest[] {
    return [...this.manifests.values()];
  }

  deriveStatus(
    manifest: PluginManifest,
    capabilities: CapabilitiesConfig | null,
    env: Record<string, string | undefined>,
  ): PluginStatus {
    const allConfigured = manifest.config.filter((f) => f.required).every((f) => !!env[f.envName]);
    if (!capabilities) return allConfigured ? 'configured' : 'not_configured';

    const capEntries = capabilities.capabilities.filter((c) => c.pluginId === manifest.id);
    const declaredIds = new Set(manifest.resources.map((r) => resourceCapId(manifest.id, r)));
    const declaredEntries = capEntries.filter((c) => declaredIds.has(normalizeCapId(c.id)));

    if (capEntries.length === 0) return allConfigured ? 'configured' : 'not_configured';

    // F202 Phase 2 follow-up: optional resources don't block 'enabled' status — only required resources must be active
    const requiredResources = manifest.resources.filter((r) => !r.optional);
    const allRequiredEnabled =
      requiredResources.length > 0 &&
      requiredResources.every((resource) =>
        declaredEntries.some(
          (c) => normalizeCapId(c.id) === resourceCapId(manifest.id, resource) && c.type === resource.type && c.enabled,
        ),
      );
    if (allRequiredEnabled) return allConfigured ? 'enabled' : 'partial';

    const someRuntimeEnabled = capEntries.some((c) => c.enabled);
    if (someRuntimeEnabled) return 'partial';

    return allConfigured ? 'configured' : 'not_configured';
  }

  getPluginInfo(
    manifest: PluginManifest,
    capabilities: CapabilitiesConfig | null,
    env: Record<string, string | undefined>,
  ): PluginInfo {
    const status = this.deriveStatus(manifest, capabilities, env);
    const allConfigured = manifest.config.filter((f) => f.required).every((f) => !!env[f.envName]);

    const isSensitive = (f: (typeof manifest.config)[number]) => f.type === 'input' && f.sensitive;
    const configWithValues = manifest.config.map((f) => ({
      ...f,
      sensitive: isSensitive(f),
      currentValue: maskValue(env[f.envName], isSensitive(f)),
    }));

    const resourceStatuses: PluginResourceStatus[] = manifest.resources.map((r) => {
      const capEntry = capabilities?.capabilities.find(
        (c) =>
          c.pluginId === manifest.id && c.type === r.type && normalizeCapId(c.id) === resourceCapId(manifest.id, r),
      );
      return {
        type: r.type,
        path: r.path,
        name: r.name,
        enabled: capEntry?.enabled ?? false,
      };
    });

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      icon: manifest.icon,
      iconBg: manifest.iconBg,
      docsUrl: manifest.docsUrl,
      setupSteps: manifest.setupSteps,
      status,
      configured: allConfigured,
      config: configWithValues,
      healthCheck: manifest.healthCheck,
      resources: resourceStatuses,
      hasHealthCheck: !!manifest.healthCheck?.limbCommand,
    };
  }
}

export function resourceCapId(pluginId: string, resource: { type: string; path?: string; name?: string }): string {
  if (resource.type === 'skill' && resource.path) {
    return resourcePathBasename(resource.path);
  }
  if (resource.type === 'mcp' && resource.name) {
    return `plugin:${pluginId}:${resource.name}`;
  }
  const suffix = resource.path ? resourcePathSegments(resource.path).join('/') : (resource.name ?? resource.type);
  return `plugin:${pluginId}:${suffix}`;
}

/**
 * Normalize a stored capability ID so that old entries with backslash path
 * separators (e.g. `plugin:x:limbs\\node.yaml`) match the current canonical
 * form (`plugin:x:limbs/node.yaml`). Safe to call on already-normalized IDs.
 */
export function normalizeCapId(capId: string): string {
  return capId.replace(/\\/g, '/');
}

export function resourcePathSegments(resourcePath: string): string[] {
  return resourcePath.split(/[\\/]+/).filter(Boolean);
}

export function resourcePathBasename(resourcePath: string): string {
  const segments = resourcePathSegments(resourcePath);
  return segments.at(-1) ?? resourcePath;
}

export function resolvePluginResourcePath(pluginsDir: string, pluginId: string, resourcePath: string): string {
  return join(pluginsDir, pluginId, ...resourcePathSegments(resourcePath));
}
