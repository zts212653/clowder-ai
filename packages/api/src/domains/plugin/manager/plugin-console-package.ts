import { readdir, readFile } from 'node:fs/promises';
import type { PluginPdlFragment } from '@cat-cafe/shared';

// A plugin's console package: <plugin id>/pdl.json, optional i18n/<language>.json and app.js.
const root = new URL('../../../../plugin-consoles/', import.meta.url);

export async function readPluginConsole(pluginId: string): Promise<PluginPdlFragment | undefined> {
  const dir = new URL(encodeURIComponent(pluginId) + '/', root);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const read = (name: string) => readFile(new URL(name, dir), 'utf8');
  const fragment = JSON.parse(await read('pdl.json')) as PluginPdlFragment;
  if (names.includes('i18n')) {
    const files = (await readdir(new URL('i18n/', dir))).filter((name) => name.endsWith('.json'));
    fragment.i18n = Object.fromEntries(
      await Promise.all(files.map(async (name) => [name.slice(0, -5), JSON.parse(await read('i18n/' + name))])),
    );
  }
  if (names.includes('app.js')) fragment.app = await read('app.js');
  return fragment;
}
