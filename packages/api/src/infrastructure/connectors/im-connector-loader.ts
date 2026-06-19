/**
 * IM Connector Loader — F240
 *
 * Discovers and loads built-in and installed IM connector plugins.
 * - Built-in: statically imported from `im-connectors/`
 * - Installed: dynamically imported from `.cat-cafe/plugins/<id>/index.js` (Phase B)
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { IMConnectorPlugin } from './im-connector-plugin.js';
import { resolvePluginModuleCacheDir, resolvePluginsDir } from './plugins/plugin-installer.js';

/**
 * Load all built-in IM connector plugins.
 * Static imports ensure tree-shaking and compile-time type checking.
 */
export async function loadBuiltinConnectors(): Promise<IMConnectorPlugin[]> {
  const modules = await Promise.all([
    import('./im-connectors/feishu/index.js'),
    import('./im-connectors/telegram/index.js'),
    import('./im-connectors/dingtalk/index.js'),
    import('./im-connectors/xiaoyi/index.js'),
    import('./im-connectors/wecom-bot/index.js'),
    import('./im-connectors/wecom-agent/index.js'),
    import('./im-connectors/weixin/index.js'),
  ]);
  return modules.map((m) => m.default);
}

function hashPluginModuleGraph(dir: string): string {
  const hash = createHash('sha256');

  const visit = (currentDir: string, relativeDir = ''): void => {
    const entries = readdirSync(currentDir).sort();
    for (const entry of entries) {
      const absolute = join(currentDir, entry);
      const relative = relativeDir ? `${relativeDir}/${entry}` : entry;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`dir\0${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        hash.update(`file\0${relative}\0${stat.size}\0`);
        hash.update(readFileSync(absolute));
      }
    }
  };

  visit(dir);
  return hash.digest('hex').slice(0, 16);
}

function materializeVersionedPluginModule(projectRoot: string, pluginId: string, sourceDir: string): string {
  const graphHash = hashPluginModuleGraph(sourceDir);
  const cacheRoot = resolvePluginModuleCacheDir(projectRoot, pluginId);
  const cacheDir = join(cacheRoot, graphHash);
  if (!existsSync(cacheDir)) {
    rmSync(cacheRoot, { recursive: true, force: true });
    cpSync(sourceDir, cacheDir, { recursive: true });
    const packageJsonPath = join(cacheDir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      writeFileSync(packageJsonPath, '{\n  "type": "module"\n}\n');
    }
  }
  return join(cacheDir, 'index.js');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConnectorIconSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'png') return typeof value.src === 'string';
  if (value.type === 'svg') return typeof value.iconId === 'string' || typeof value.src === 'string';
  return false;
}

/**
 * Load installed plugins from `.cat-cafe/plugins/` directory (Phase B).
 * Each subdirectory must contain `index.js` exporting an IMConnectorPlugin.
 */
export async function loadInstalledPlugins(projectRoot: string, log: FastifyBaseLogger): Promise<IMConnectorPlugin[]> {
  const pluginsDir = resolvePluginsDir(projectRoot);
  if (!existsSync(pluginsDir)) return [];

  const entries = readdirSync(pluginsDir).filter((e) => !e.startsWith('.'));
  const results: IMConnectorPlugin[] = [];

  for (const entry of entries) {
    const dir = join(pluginsDir, entry);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const entryPath = join(dir, 'index.js');
    if (!existsSync(entryPath)) {
      log.warn({ plugin: entry }, '[IMConnectorLoader] Plugin missing index.js — skipped');
      continue;
    }

    try {
      const versionedEntryPath = materializeVersionedPluginModule(projectRoot, entry, dir);
      const fileUrl = pathToFileURL(versionedEntryPath);
      const mod = await import(fileUrl.href);
      const plugin: IMConnectorPlugin = mod.default ?? mod;

      if (!validatePluginInterface(plugin, entry, log)) continue;
      if (!validateInstalledPluginIdentity(plugin, entry, log)) continue;

      results.push(plugin);
      log.info({ id: plugin.id, dir: entry }, '[IMConnectorLoader] Installed plugin loaded');
    } catch (err) {
      log.warn({ err, plugin: entry }, '[IMConnectorLoader] Failed to load installed plugin');
    }
  }

  return results;
}

/** Validate that a loaded module satisfies the IMConnectorPlugin contract. */
function validatePluginInterface(plugin: IMConnectorPlugin, source: string, log: FastifyBaseLogger): boolean {
  if (!plugin.id || typeof plugin.id !== 'string') {
    log.warn({ source }, '[IMConnectorLoader] Plugin missing `id` — skipped');
    return false;
  }
  if (!plugin.definition || typeof plugin.definition !== 'object') {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin missing `definition` — skipped');
    return false;
  }
  if (!isConnectorIconSpec(plugin.definition.icon)) {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin `definition.icon` is invalid — skipped');
    return false;
  }
  if (typeof plugin.createAdapter !== 'function') {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin missing `createAdapter()` — skipped');
    return false;
  }
  if (typeof plugin.isConfigured !== 'function') {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin missing `isConfigured()` — skipped');
    return false;
  }
  if (!isStringArray(plugin.requiredEnvKeys)) {
    log.warn(
      { source, id: plugin.id },
      '[IMConnectorLoader] Plugin `requiredEnvKeys` must be a string array — skipped',
    );
    return false;
  }
  if (plugin.optionalEnvKeys != null && !isStringArray(plugin.optionalEnvKeys)) {
    log.warn(
      { source, id: plugin.id },
      '[IMConnectorLoader] Plugin `optionalEnvKeys` must be a string array — skipped',
    );
    return false;
  }
  return true;
}

function validateInstalledPluginIdentity(plugin: IMConnectorPlugin, dirId: string, log: FastifyBaseLogger): boolean {
  if (plugin.id !== dirId) {
    log.warn(
      { dir: dirId, id: plugin.id },
      '[IMConnectorLoader] Installed plugin id differs from directory id — skipped',
    );
    return false;
  }

  if (plugin.definition.id !== dirId) {
    log.warn(
      { dir: dirId, id: plugin.id, definitionId: plugin.definition.id },
      '[IMConnectorLoader] Installed plugin definition id differs from directory id — skipped',
    );
    return false;
  }

  return true;
}

/**
 * Load all IM connector plugins (built-in + installed).
 * IDs that conflict with built-in IDs are rejected.
 */
export async function loadAllIMConnectors(log: FastifyBaseLogger, projectRoot?: string): Promise<IMConnectorPlugin[]> {
  const builtins = await loadBuiltinConnectors();
  const builtinIds = new Set(builtins.map((c) => c.id));

  // Phase B: load from .cat-cafe/plugins/ directory
  const installed = projectRoot ? await loadInstalledPlugins(projectRoot, log) : [];

  // Reject installed plugins that conflict with built-in IDs or each other
  const validExternals: IMConnectorPlugin[] = [];
  const seenIds = new Set<string>();

  for (const ext of installed) {
    if (builtinIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[IMConnectorLoader] External connector ID conflicts with built-in — skipped');
      continue;
    }
    if (seenIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[IMConnectorLoader] Duplicate external connector ID — skipped');
      continue;
    }
    seenIds.add(ext.id);
    validExternals.push(ext);
  }

  const all = [...builtins, ...validExternals];
  log.info(
    { builtin: builtins.length, installed: installed.length, total: all.length },
    '[IMConnectorLoader] All IM connectors loaded',
  );
  return all;
}
