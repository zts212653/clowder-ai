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

export function packagesRoot(projectRoot: string): string {
  return join(projectRoot, '.cat-cafe', 'console-themes');
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

async function installedComponents(root: string, ownId: string, uses: string[], files: Record<string, Buffer>) {
  const sources: Record<string, Record<string, Buffer>> = Object.create(null);
  const missing = new Set(uses.filter((id) => !componentFiles(files, id).length));
  for (const id of await packageIds(root)) {
    if (!missing.size) break;
    if (id === ownId) continue;
    const installed = await packageFiles(join(root, id));
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
    /^assets\/[^/]+\.(png|jpg|jpeg|webp|gif|svg|woff2|woff|ttf)$/.test(name)
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

export async function installPackage(projectRoot: string, zip: Buffer): Promise<{ id: string } | { custom: Theme }> {
  const files = packageLayout(readZip(zip));
  let value: unknown;
  try {
    value = parse(files['theme.yaml'].toString('utf8'));
  } catch {
    throw new Error('Invalid theme.yaml');
  }
  const theme = validateTheme(value);
  if ('doc' in theme.pdl) return { custom: theme };
  for (const name of Object.keys(files).filter((name) => name.startsWith('i18n/'))) {
    try {
      if (!z.record(z.unknown()).safeParse(JSON.parse(files[name].toString('utf8'))).success) throw new Error();
    } catch {
      throw new Error('Invalid i18n JSON');
    }
  }
  const root = packagesRoot(projectRoot);
  await installedComponents(root, theme.id, theme.uses ?? [], files);
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

export async function listPackages(projectRoot: string) {
  const root = packagesRoot(projectRoot);
  return Promise.all(
    (await packageIds(root)).map(async (id) => identity(parse(await readFile(join(root, id, 'theme.yaml'), 'utf8')))),
  );
}

export async function readPackage(projectRoot: string, id: string) {
  const root = packagesRoot(projectRoot);
  const files = await packageFiles(join(root, id));
  const theme: Theme = parse(files['theme.yaml'].toString('utf8'));
  const uses = theme.uses ?? [];
  const sources = await installedComponents(root, id, uses, files);
  const components: Record<string, { js: string[]; css: string[] }> = Object.create(null);
  for (const component of uses) {
    const source = sources[component] ?? files;
    components[component] = { js: [], css: [] };
    for (const name of componentFiles(source, component)) {
      components[component][extname(name) === '.js' ? 'js' : 'css'].push(source[name].toString('utf8'));
    }
  }
  const i18n: Record<string, Record<string, unknown>> = Object.create(null);
  const assets: Record<string, { type: 'image' | 'font'; mime: string; src: string }> = Object.create(null);
  for (const name of Object.keys(files).sort()) {
    if (name.startsWith('i18n/')) {
      const lang = name.split('/')[1];
      i18n[lang] = { ...i18n[lang], ...JSON.parse(files[name].toString('utf8')) };
    } else if (name.startsWith('assets/')) {
      const file = name.slice('assets/'.length);
      const extension = extname(file);
      const mime = assetMimes[extension];
      assets[file.slice(0, -extension.length)] = {
        type: mime.startsWith('font/') ? 'font' : 'image',
        mime,
        src: `/api/console-themes/packages/${id}/assets/${encodeURIComponent(file)}`,
      };
    }
  }
  return { ...identity(theme), uses, pdl: theme.pdl, components, i18n, assets };
}

export async function exportPackage(projectRoot: string, id: string): Promise<Buffer> {
  return writeZip(await packageFiles(join(packagesRoot(projectRoot), id)));
}

export function exportCustomTheme(value: unknown): { id: string; zip: Buffer } {
  const theme = validateTheme(value);
  if (!('doc' in theme.pdl)) throw new Error('Expected a custom theme');
  return { id: theme.id, zip: writeZip({ 'theme.yaml': Buffer.from(stringify(theme)) }) };
}
