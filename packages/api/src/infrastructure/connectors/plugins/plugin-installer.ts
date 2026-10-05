/**
 * Plugin Installer — F240 Phase B
 *
 * Installs, updates, and uninstalls external IM connector plugins.
 * Plugin packages are tar.gz archives containing:
 *   <connectorId>/
 *     connector.yaml   — manifest (must match directory name)
 *     index.js         — IMConnectorPlugin default export
 *     assets/          — optional static resources (icons, etc.)
 *
 * Installed plugins live in `.cat-cafe/plugins/<connectorId>/`.
 * Config data lives separately in `.cat-cafe/im-connector-config/<connectorId>.json`
 * and is preserved across updates/reinstalls.
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, opendir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type ConnectorManifest,
  parseConnectorManifest,
  parseConnectorManifestContent,
} from './im-connector-manifest.js';

import { pathExists, replacePluginTree, withPluginMutation } from './plugin-filesystem.js';

const execFileAsync = promisify(execFile);

const PLUGINS_DIR_NAME = 'plugins';
const PLUGIN_MODULE_CACHE_DIR_NAME = 'plugin-module-cache';
const CONNECTOR_YAML = 'connector.yaml';
const PLUGIN_ENTRY = 'index.js';

/** Valid connector ID: lowercase alphanumeric + hyphens, 1-64 chars, no leading/trailing hyphen. */
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

function resolveTarCommand(tarBin?: string): string {
  return tarBin?.trim() || 'tar';
}

function isValidConnectorId(id: string): boolean {
  return id.length >= 1 && id.length <= 64 && CONNECTOR_ID_PATTERN.test(id) && !id.includes('--');
}

// ── Types ──

export interface PluginInstallResult {
  id: string;
  name: string;
  version?: string;
  action: 'installed' | 'updated';
}

export interface PluginUninstallResult {
  id: string;
  action: 'uninstalled';
  configPreserved: boolean;
}

export interface InstalledPluginMeta {
  id: string;
  name: string;
  directory: string;
  hasManifest: boolean;
  hasEntry: boolean;
}

export interface PluginInstallError {
  code: 'INVALID_ARCHIVE' | 'MISSING_MANIFEST' | 'MISSING_ENTRY' | 'ID_CONFLICT' | 'EXTRACT_FAILED';
  message: string;
}

export interface PluginInstallOptions {
  tarBin?: string;
  maxExtractedEntries?: number;
  maxExtractedBytes?: number;
}

// ── Paths ──

export function resolvePluginsDir(projectRoot: string): string {
  return join(projectRoot, '.cat-cafe', PLUGINS_DIR_NAME);
}

export function resolvePluginModuleCacheDir(projectRoot: string, connectorId: string): string {
  return join(projectRoot, '.cat-cafe', PLUGIN_MODULE_CACHE_DIR_NAME, connectorId);
}

function resolvePluginDir(projectRoot: string, connectorId: string): string {
  return join(resolvePluginsDir(projectRoot), connectorId);
}

async function validateExtractedTreeHasNoSymlinks(
  rootDir: string,
  opts: PluginInstallOptions,
): Promise<PluginInstallError | null> {
  let rootStat: Stats;
  try {
    rootStat = await lstat(rootDir);
  } catch (err) {
    return { code: 'INVALID_ARCHIVE', message: `Invalid plugin archive: ${(err as Error).message}` };
  }
  if (!rootStat.isDirectory()) {
    return { code: 'INVALID_ARCHIVE', message: 'Archive top-level entry must be a directory' };
  }

  return inspectExtractedEntries(rootDir, opts);
}

async function inspectExtractedEntries(
  rootDir: string,
  opts: PluginInstallOptions,
): Promise<PluginInstallError | null> {
  let entriesSeen = 0;
  let bytesSeen = 0;
  const maxEntries = opts.maxExtractedEntries ?? 20_000;
  const maxBytes = opts.maxExtractedBytes ?? 250 * 1024 * 1024;
  const stack = [rootDir];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name);
      const stat = await lstat(path);
      entriesSeen++;
      bytesSeen += stat.isFile() ? stat.size : 0;
      if (entriesSeen > maxEntries || bytesSeen > maxBytes) {
        return { code: 'INVALID_ARCHIVE', message: 'Plugin archive exceeds expanded entry or byte budget' };
      }
      if (stat.isSymbolicLink()) {
        return { code: 'INVALID_ARCHIVE', message: `Plugin archive must not contain symlinks: ${entry.name}` };
      }
      if (stat.isDirectory()) stack.push(path);
    }
  }

  return null;
}

// ── Install ──

/**
 * Install or update a plugin from a tar.gz buffer.
 *
 * Steps:
 * 1. Extract archive to a temp directory
 * 2. Find the single top-level directory
 * 3. Validate connector.yaml (id, name, config) and index.js presence
 * 4. Check for built-in ID conflicts
 * 5. Move to `.cat-cafe/plugins/<id>/`
 *
 * On update (existing ID): replaces plugin files but preserves config store.
 */
export async function installPlugin(
  projectRoot: string,
  archivePath: string,
  builtinIds: ReadonlySet<string>,
  opts: PluginInstallOptions = {},
): Promise<PluginInstallResult | PluginInstallError> {
  const pluginsDir = resolvePluginsDir(projectRoot);
  await mkdir(pluginsDir, { recursive: true });
  const tmpDir = await mkdtemp(join(pluginsDir, '.tmp-install-'));

  try {
    // Extract tar.gz
    try {
      await execFileAsync(resolveTarCommand(opts.tarBin), ['xzf', archivePath, '-C', tmpDir], { timeout: 30_000 });
    } catch (err) {
      return { code: 'EXTRACT_FAILED', message: `Failed to extract archive: ${(err as Error).message}` };
    }

    // Find the single top-level directory
    const entries = (await readdir(tmpDir)).filter((e) => !e.startsWith('.'));
    if (entries.length !== 1) {
      return {
        code: 'INVALID_ARCHIVE',
        message: `Archive must contain exactly one top-level directory, found ${entries.length}`,
      };
    }

    const extractedDir = join(tmpDir, entries[0]);
    const treeError = await validateExtractedTreeHasNoSymlinks(extractedDir, opts);
    if (treeError) return treeError;

    // Validate connector.yaml
    const yamlPath = join(extractedDir, CONNECTOR_YAML);
    if (!(await pathExists(yamlPath))) {
      return { code: 'MISSING_MANIFEST', message: `Plugin must contain ${CONNECTOR_YAML}` };
    }
    const manifestStat = await lstat(yamlPath);
    if (!manifestStat.isFile() || manifestStat.size > 128 * 1024) {
      return { code: 'INVALID_ARCHIVE', message: `Plugin ${CONNECTOR_YAML} must be a regular file of at most 128 KiB` };
    }

    const yamlContent = await readFile(yamlPath, 'utf-8');
    let manifest: ConnectorManifest;
    try {
      manifest = parseConnectorManifestContent(yamlContent, yamlPath);
    } catch (err) {
      return { code: 'MISSING_MANIFEST', message: `Invalid ${CONNECTOR_YAML}: ${(err as Error).message}` };
    }

    // Validate connector ID format (prevent path traversal and invalid chars)
    if (!isValidConnectorId(manifest.id)) {
      return {
        code: 'INVALID_ARCHIVE',
        message: `Invalid connector ID '${manifest.id}': must be lowercase alphanumeric with hyphens, 1-64 chars`,
      };
    }

    // Validate index.js
    const entryPath = join(extractedDir, PLUGIN_ENTRY);
    if (!(await pathExists(entryPath))) {
      return { code: 'MISSING_ENTRY', message: `Plugin must contain ${PLUGIN_ENTRY}` };
    }
    if (!(await lstat(entryPath)).isFile()) {
      return { code: 'INVALID_ARCHIVE', message: `Plugin ${PLUGIN_ENTRY} must be a regular file` };
    }

    // Force-write source: 'external' into manifest — overrides any user-supplied value.
    // This is the single authority for marking a connector as externally installed.
    const rawYaml = parseYaml(yamlContent) as Record<string, unknown>;
    rawYaml.source = 'external';
    await writeFile(yamlPath, stringifyYaml(rawYaml));

    // Check for built-in ID conflict
    if (builtinIds.has(manifest.id)) {
      return {
        code: 'ID_CONFLICT',
        message: `Plugin ID '${manifest.id}' conflicts with a built-in connector`,
      };
    }

    // Determine action (install vs update)
    const targetDir = resolvePluginDir(projectRoot, manifest.id);
    return await withPluginMutation(targetDir, async () => {
      const isUpdate = await replacePluginTree(extractedDir, targetDir);
      return { id: manifest.id, name: manifest.name, action: isUpdate ? 'updated' : 'installed' };
    });
  } finally {
    // Clean up temp directory
    if (await pathExists(tmpDir)) {
      try {
        await rm(tmpDir, { recursive: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ── Uninstall ──

/**
 * Uninstall a plugin by removing its directory.
 * Config store data is preserved by default (user can reinstall without reconfiguring).
 */
export async function uninstallPlugin(
  projectRoot: string,
  connectorId: string,
  opts: { clearConfig?: boolean } = {},
): Promise<PluginUninstallResult | PluginInstallError> {
  // Validate ID format to prevent path traversal (e.g. "../../etc")
  if (!isValidConnectorId(connectorId)) {
    return {
      code: 'INVALID_ARCHIVE',
      message: `Invalid connector ID '${connectorId}': must be lowercase alphanumeric with hyphens, 1-64 chars`,
    };
  }

  const pluginDir = resolvePluginDir(projectRoot, connectorId);

  return withPluginMutation(pluginDir, async () => {
    if (!(await pathExists(pluginDir))) {
      return { code: 'INVALID_ARCHIVE', message: `Plugin '${connectorId}' is not installed` };
    }

    await rm(pluginDir, { recursive: true });
    await rm(resolvePluginModuleCacheDir(projectRoot, connectorId), { recursive: true, force: true });

    if (opts.clearConfig) {
      const configPath = join(projectRoot, '.cat-cafe', 'im-connector-config', `${connectorId}.json`);
      if (await pathExists(configPath)) {
        await rm(configPath);
      }
    }

    return {
      id: connectorId,
      action: 'uninstalled',
      configPreserved: !opts.clearConfig,
    };
  });
}

// ── Discovery ──

/** List all installed plugins in the plugins directory. */
export function listInstalledPlugins(projectRoot: string): InstalledPluginMeta[] {
  const pluginsDir = resolvePluginsDir(projectRoot);
  if (!existsSync(pluginsDir)) return [];

  const results: InstalledPluginMeta[] = [];

  for (const entry of readdirSync(pluginsDir)) {
    if (entry.startsWith('.')) continue;
    const dir = join(pluginsDir, entry);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const hasManifest = existsSync(join(dir, CONNECTOR_YAML));
    const hasEntry = existsSync(join(dir, PLUGIN_ENTRY));

    let name = entry;
    if (hasManifest) {
      try {
        const m = parseConnectorManifest(join(dir, CONNECTOR_YAML));
        name = m.name;
      } catch {
        /* use directory name */
      }
    }

    results.push({ id: entry, name, directory: dir, hasManifest, hasEntry });
  }

  return results;
}
