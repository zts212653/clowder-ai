import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { PluginConfigField, PluginHealthCheck, PluginManifest, PluginResourceDef } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';
import { resourceCapId } from './PluginRegistry.js';

const SYSTEM_ENV_DENYLIST_PREFIXES = [
  'CAT_CAFE_',
  'REDIS_',
  'DATABASE_',
  'API_SERVER_',
  'FRONTEND_',
  'PREVIEW_',
  'AGENT_KEY_',
  'JWT_',
  'SESSION_',
];

const SYSTEM_ENV_DENYLIST_EXACT = new Set(['NODE_OPTIONS', 'NODE_ENV', 'PATH', 'HOME', 'SHELL', 'PORT']);

const SUPPORTED_RESOURCE_TYPES = new Set(['skill', 'mcp', 'limb']);
const DEFERRED_RESOURCE_TYPES = new Set(['schedule']);

export const BUILTIN_PLUGIN_IDS = new Set<string>();

export interface EnvSafetyResult {
  ok: boolean;
  errors: string[];
}

function isSystemEnv(envName: string): boolean {
  const upper = envName.toUpperCase();
  if (SYSTEM_ENV_DENYLIST_EXACT.has(upper)) return true;
  return SYSTEM_ENV_DENYLIST_PREFIXES.some((p) => upper.startsWith(p));
}

function isUnsafeResourcePath(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]+/).includes('..');
}

function envClaimKey(envName: string): string {
  return envName.toUpperCase();
}

export function validateEnvSafety(manifest: PluginManifest, existingClaims: Map<string, string>): EnvSafetyResult {
  const errors: string[] = [];
  const pluginPrefix = manifest.id.toUpperCase().replace(/-/g, '_') + '_';
  const normalizedClaims = new Map<string, string>();
  for (const [envName, pluginId] of existingClaims) {
    normalizedClaims.set(envClaimKey(envName), pluginId);
  }

  for (const field of manifest.config) {
    if (isSystemEnv(field.envName)) {
      errors.push(`'${field.envName}' is a reserved system variable`);
      continue;
    }

    if (!manifest.builtin && !field.envName.toUpperCase().startsWith(pluginPrefix)) {
      errors.push(`Community plugin '${manifest.id}' env '${field.envName}' must start with '${pluginPrefix}'`);
      continue;
    }

    const owner = normalizedClaims.get(envClaimKey(field.envName));
    if (owner && owner !== manifest.id) {
      errors.push(`'${field.envName}' already claimed by plugin '${owner}'`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parsePluginManifest(yamlPath: string): PluginManifest {
  const raw = readFileSync(yamlPath, 'utf-8');
  const doc = parseYaml(raw) as Record<string, unknown>;

  const id = doc['id'];
  const name = doc['name'];
  const version = doc['version'];
  if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`Invalid plugin manifest at ${yamlPath}: id, name, and version must be strings`);
  }
  if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new Error(
      `Invalid plugin id '${id}': must start with a letter, contain only a-z, 0-9, hyphens, no trailing hyphen`,
    );
  }

  const config: PluginConfigField[] = [];
  const rawConfig = doc['config'];
  if (Array.isArray(rawConfig)) {
    for (const c of rawConfig) {
      const rc = c as Record<string, unknown>;
      if (typeof rc['envName'] !== 'string' || typeof rc['label'] !== 'string') {
        throw new Error(`Invalid config entry in ${yamlPath}: envName and label must be strings`);
      }
      const envName = rc['envName'];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        throw new Error(`Invalid envName '${envName}': must be a valid shell variable name`);
      }
      config.push({
        envName,
        label: rc['label'],
        sensitive: rc['sensitive'] === true,
        required: rc['required'] !== false,
      });
    }
  }

  const resources: PluginResourceDef[] = [];
  const rawResources = doc['resources'];
  if (Array.isArray(rawResources)) {
    for (const r of rawResources) {
      const rr = r as Record<string, unknown>;
      const rawType = rr['type'];
      if (typeof rawType !== 'string') {
        throw new Error(`Invalid resource entry in ${yamlPath}: type must be a string`);
      }
      const type = rawType;
      if (DEFERRED_RESOURCE_TYPES.has(type)) {
        console.warn(`[PluginManifest] resource type '${type}' not yet supported, skipping`);
        continue;
      }
      if (!SUPPORTED_RESOURCE_TYPES.has(type)) {
        throw new Error(`Unsupported resource type '${type}' in ${yamlPath}`);
      }

      const rawPath = rr['path'];
      if (rawPath != null && typeof rawPath !== 'string') {
        throw new Error(`Invalid resource path in ${yamlPath}: must be a string`);
      }
      const path = rawPath as string | undefined;
      if (path && isUnsafeResourcePath(path)) {
        throw new Error(`Invalid resource path '${path}': must be relative without '..'`);
      }

      const rawArgs = rr['args'];
      let args: string[] | undefined;
      if (rawArgs != null) {
        if (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === 'string')) {
          throw new Error(`Invalid resource args in ${yamlPath}: must be an array of strings`);
        }
        args = rawArgs as string[];
      }

      const command = rr['command'];
      if (command != null && typeof command !== 'string') {
        throw new Error(`Invalid resource command in ${yamlPath}: must be a string`);
      }

      const rawTransport = rr['transport'];
      if (rawTransport != null && typeof rawTransport !== 'string') {
        throw new Error(`Invalid resource transport in ${yamlPath}: must be a string`);
      }
      const transport = rawTransport as PluginResourceDef['transport'] | undefined;
      if (type === 'mcp' && transport && transport !== 'stdio' && transport !== 'streamableHttp') {
        throw new Error(`Invalid MCP resource transport in ${yamlPath}: must be 'stdio' or 'streamableHttp'`);
      }

      const url = rr['url'];
      if (url != null && typeof url !== 'string') {
        throw new Error(`Invalid resource url in ${yamlPath}: must be a string`);
      }

      const rawName = rr['name'];
      if (rawName != null && typeof rawName !== 'string') {
        throw new Error(`Invalid resource name in ${yamlPath}: must be a string`);
      }
      const name = rawName as string | undefined;
      if ((type === 'skill' || type === 'limb') && !path) {
        const label = type === 'skill' ? 'Skill' : 'Limb';
        throw new Error(`${label} resource in ${yamlPath} must have a 'path' field`);
      }
      if (type === 'mcp' && !name) {
        throw new Error(`MCP resource in ${yamlPath} must have a 'name' field for unique capability ID`);
      }
      if (type === 'mcp' && name && /[/\\]/.test(name)) {
        throw new Error(`MCP resource name '${name}' in ${yamlPath} must not contain path separators (/ or \\)`);
      }
      if (type === 'mcp' && transport === 'streamableHttp' && (!url || url.trim().length === 0)) {
        throw new Error(`MCP streamableHttp resource in ${yamlPath} must have a 'url' field`);
      }
      if (type === 'mcp' && transport !== 'streamableHttp' && !command) {
        throw new Error(`MCP resource in ${yamlPath} must have a 'command' field`);
      }

      resources.push({
        type: type as PluginResourceDef['type'],
        path,
        name,
        command: command as string | undefined,
        args,
        transport,
        url: url as string | undefined,
      });
    }
  }

  const seenCapIds = new Set<string>();
  for (const res of resources) {
    const capId = resourceCapId(id, res);
    if (seenCapIds.has(capId)) {
      throw new Error(`Duplicate resource capability ID '${capId}' in ${yamlPath}`);
    }
    seenCapIds.add(capId);
  }

  let healthCheck: PluginHealthCheck | undefined;
  const rawHC = doc['healthCheck'] as Record<string, unknown> | undefined;
  if (rawHC) {
    const limbCommand = rawHC['limbCommand'] as string | undefined;
    const mcpProbe = rawHC['mcpProbe'] as string | undefined;
    if (limbCommand || mcpProbe) {
      healthCheck = { limbCommand, mcpProbe };
    }
  }

  const docsUrl = typeof doc['docsUrl'] === 'string' ? doc['docsUrl'] : undefined;
  const rawSteps = doc['setupSteps'];
  const setupSteps = Array.isArray(rawSteps) ? rawSteps.filter((s): s is string => typeof s === 'string') : undefined;

  return {
    id,
    name,
    version,
    description: typeof doc['description'] === 'string' ? doc['description'] : undefined,
    icon: typeof doc['icon'] === 'string' ? doc['icon'] : undefined,
    iconBg: typeof doc['iconBg'] === 'string' ? doc['iconBg'] : undefined,
    builtin: false,
    docsUrl,
    setupSteps: setupSteps && setupSteps.length > 0 ? setupSteps : undefined,
    config,
    healthCheck,
    resources,
  };
}
