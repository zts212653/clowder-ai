import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { readZip, writeZip } from './zip.js';

export const themeId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const themeSchema = z
  .object({
    id: z.string().regex(themeId),
    name: z.string().min(1),
    version: z.string().min(1),
    contractVersion: z.string().min(1),
    uses: z.array(z.string().min(1)).optional(),
    pdl: z.record(z.unknown()),
  })
  .passthrough();
type Theme = z.infer<typeof themeSchema>;

export const assetMimes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** One loading rule, two places: built-in packages ship with the console, the owner's own live in the project. */
export interface ThemeRoots {
  builtin: string;
  custom: string;
  builtinManifests: Map<string, { source: string; parsed: Promise<Theme> }>;
}
export function themeRoots(projectRoot: string, builtinRoot: string): ThemeRoots {
  return {
    builtin: builtinRoot,
    custom: join(projectRoot, '.cat-cafe', 'console-themes'),
    builtinManifests: new Map(),
  };
}
/** The folder of package id: a built-in one wins (its id cannot be imported over). */
export async function packageDir(roots: ThemeRoots, id: string): Promise<string> {
  return (await packageIds(roots.builtin)).includes(id) ? join(roots.builtin, id) : join(roots.custom, id);
}
export async function isBuiltin(roots: ThemeRoots, id: string): Promise<boolean> {
  return (await packageIds(roots.builtin)).includes(id);
}

function validateTheme(value: unknown): Theme {
  const parsed = themeSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid theme identity or pdl');
  return parsed.data;
}

async function packageIds(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && themeId.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function packageFiles(root: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = Object.create(null);
  async function read(path: string): Promise<void> {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await read(name);
      else files[name] = await readFile(join(root, name));
    }
  }
  await read('');
  return files;
}

function componentFiles(files: Record<string, Buffer>, id: string): string[] {
  return Object.keys(files)
    .filter((name) => name.startsWith(`components/${id}/`))
    .sort();
}

async function installedComponents(roots: ThemeRoots, ownId: string, uses: string[], files: Record<string, Buffer>) {
  const sources: Record<string, Record<string, Buffer>> = Object.create(null);
  const missing = new Set(uses.filter((id) => !componentFiles(files, id).length));
  const dirs = [
    ...(await packageIds(roots.builtin)).map((id) => [id, join(roots.builtin, id)]),
    ...(await packageIds(roots.custom)).map((id) => [id, join(roots.custom, id)]),
  ];
  for (const [id, dir] of dirs) {
    if (!missing.size) break;
    if (id === ownId) continue;
    const installed = await packageFiles(dir);
    for (const component of missing) {
      if (componentFiles(installed, component).length) {
        sources[component] = installed;
        missing.delete(component);
      }
    }
  }
  if (missing.size) throw new Error('Missing used component package');
  return sources;
}

function allowedName(name: string): boolean {
  return (
    name === 'theme.yaml' ||
    /^components\/[^/]+\/[^/]+\.(js|css)$/.test(name) ||
    /^i18n\/[^/]+\/[^/]+\.json$/.test(name) ||
    /^assets\/[^/]+\.(png|jpg|jpeg|webp|gif|svg|woff2|woff|ttf)$/.test(name) ||
    /^licenses\/[^/]+\.txt$/.test(name) // the assets' licence texts (a font's OFL) ship with the package
  );
}
/** A folder compressed with Finder / Explorer puts everything under one top folder: the package is that folder. */
function packageLayout(raw: Record<string, Buffer>): Record<string, Buffer> {
  const names = Object.keys(raw);
  const top = raw['theme.yaml'] ? '' : names.find((name) => /^[^/]+\/theme\.yaml$/.test(name))?.split('/')[0];
  if (top === undefined) throw new Error('Missing theme.yaml');
  const files: Record<string, Buffer> = Object.create(null);
  for (const name of names) {
    if (top && !name.startsWith(`${top}/`)) throw new Error('Invalid zip path');
    const path = top ? name.slice(top.length + 1) : name;
    if (!allowedName(path)) throw new Error('Invalid zip path');
    files[path] = raw[name];
  }
  return files;
}

export async function installPackage(roots: ThemeRoots, zip: Buffer): Promise<{ id: string } | { custom: Theme }> {
  const files = packageLayout(readZip(zip));
  let value: unknown;
  try {
    value = parse(files['theme.yaml'].toString('utf8'));
  } catch {
    throw new Error('Invalid theme.yaml');
  }
  const theme = validateTheme(value);
  if ('doc' in theme.pdl) return { custom: theme };
  if (await isBuiltin(roots, theme.id)) throw new Error('Built-in theme id');
  for (const name of Object.keys(files).filter((name) => name.startsWith('i18n/'))) {
    try {
      if (!z.record(z.unknown()).safeParse(JSON.parse(files[name].toString('utf8'))).success) throw new Error();
    } catch {
      throw new Error('Invalid i18n JSON');
    }
  }
  const root = roots.custom;
  await installedComponents(roots, theme.id, theme.uses ?? [], files);
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, '.import-'));
  const target = join(root, theme.id);
  const previous = join(temporary, 'previous');
  const incoming = join(temporary, 'incoming');
  let moved = false;
  try {
    await mkdir(incoming);
    for (const [name, data] of Object.entries(files)) {
      await mkdir(dirname(join(incoming, name)), { recursive: true });
      await writeFile(join(incoming, name), data);
    }
    try {
      await rename(target, previous);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(incoming, target);
    } catch (error) {
      if (moved) {
        await rename(previous, target);
        moved = false;
      }
      throw error;
    }
    moved = false;
  } finally {
    if (!moved) await rm(temporary, { recursive: true, force: true });
  }
  return { id: theme.id };
}

function identity(theme: Theme) {
  const { id, name, version, contractVersion } = theme;
  return { id, name, version, contractVersion };
}

/** Trusted worker entry point for the CPU-bound part of a theme read. */
export function parseThemeManifest(source: string): Theme {
  return parse(source);
}

async function readManifest(roots: ThemeRoots, dir: string, id: string, source: string): Promise<Theme> {
  // Imported packages retain the existing accepted size range. The shared worker has a smaller heap.
  if (dir !== join(roots.builtin, id)) return parse(source);

  const cache = roots.builtinManifests;
  const cached = cache.get(id);
  if (cached?.source === source) return cached.parsed;

  const parsed = import('../../utils/run-module-worker.js').then(({ runModuleWorker }) =>
    runModuleWorker<Theme>({
      moduleUrl: new URL(import.meta.url),
      exportName: 'parseThemeManifest',
      input: source,
    }),
  );
  const entry = { source, parsed };
  cache.set(id, entry);
  void parsed.catch(() => {
    if (cache.get(id) === entry) cache.delete(id);
  });
  return parsed;
}

export async function listPackages(roots: ThemeRoots) {
  const builtin = await packageIds(roots.builtin);
  const read = async (root: string, id: string) => {
    const dir = join(root, id);
    return readManifest(roots, dir, id, await readFile(join(dir, 'theme.yaml'), 'utf8'));
  };
  return [
    ...(await Promise.all(builtin.map(async (id) => ({ ...identity(await read(roots.builtin, id)), builtin: true })))),
    ...(await Promise.all(
      (
        await packageIds(roots.custom)
      )
        .filter((id) => !builtin.includes(id))
        .map(async (id) => identity(await read(roots.custom, id))),
    )),
  ];
}

export async function readPackage(roots: ThemeRoots, id: string) {
  const dir = await packageDir(roots, id);
  const files = await packageFiles(dir);
  const theme = await readManifest(roots, dir, id, files['theme.yaml'].toString('utf8'));
  const uses = theme.uses ?? [];
  const sources = await installedComponents(roots, id, uses, files);
  const components: Record<string, { js: string[]; css: string[] }> = Object.create(null);
  for (const component of uses) {
    const source = sources[component] ?? files;
    components[component] = { js: [], css: [] };
    for (const name of componentFiles(source, component)) {
      components[component][extname(name) === '.js' ? 'js' : 'css'].push(source[name].toString('utf8'));
    }
  }
  const i18n: Record<string, Record<string, unknown>> = Object.create(null);
  // theme.yaml may describe an asset (a font's family / weight, its licence): the description travels with it
  const meta = (theme.assets ?? {}) as Record<string, Record<string, unknown>>;
  const assets: Record<string, Record<string, unknown> & { type: 'image' | 'font'; mime: string; src: string }> =
    Object.create(null);
  for (const name of Object.keys(files).sort()) {
    if (name.startsWith('i18n/')) {
      const lang = name.split('/')[1];
      i18n[lang] = { ...i18n[lang], ...JSON.parse(files[name].toString('utf8')) };
    } else if (name.startsWith('assets/')) {
      const file = name.slice('assets/'.length);
      const extension = extname(file);
      const mime = assetMimes[extension];
      const key = file.slice(0, -extension.length);
      assets[key] = {
        ...meta[key],
        type: mime.startsWith('font/') ? 'font' : 'image',
        mime,
        src: `/api/console-themes/packages/${id}/assets/${encodeURIComponent(file)}`,
      };
    }
  }
  return { ...identity(theme), uses, pdl: theme.pdl, components, i18n, assets };
}

export async function exportPackage(roots: ThemeRoots, id: string): Promise<Buffer> {
  return writeZip(await packageFiles(await packageDir(roots, id)));
}

export function exportCustomTheme(value: unknown): { id: string; zip: Buffer } {
  const theme = validateTheme(value);
  if (!('doc' in theme.pdl)) throw new Error('Expected a custom theme');
  return { id: theme.id, zip: writeZip({ 'theme.yaml': Buffer.from(stringify(theme)) }) };
}
