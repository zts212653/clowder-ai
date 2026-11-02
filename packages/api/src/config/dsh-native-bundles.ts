import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument, stringify, type YAMLMap } from 'yaml';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';

const ids = new Set(['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'agent-default-model', 'acp']);

/** Identify an actual DSH package, not any other client's lib/bin.js. */
export function dshInstallation(command: string, args: readonly string[] = []) {
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, [...args]) : { command, args };
  const entry = /^node(?:\.exe)?$/i.test(basename(plan.command)) ? plan.args[0] : plan.command;
  if (!entry) return undefined;
  const candidate = resolve(dirname(entry), '../package.json');
  if (existsSync(candidate)) {
    if (JSON.parse(readFileSync(candidate, 'utf8')).name === '@deepseek-ai/dsh') return candidate;
    if (/(?:lib|src)[/\\]bin\.(?:js|ts)$/.test(entry)) return undefined;
  }
  // Portable launchers may declare their repository instead of using an npm shim.
  const paths = join(dirname(entry), 'paths.json');
  if (existsSync(paths)) {
    const metadata: unknown = JSON.parse(readFileSync(paths, 'utf8'));
    if (
      metadata &&
      typeof metadata === 'object' &&
      'repository' in metadata &&
      typeof metadata.repository === 'string'
    ) {
      const manifest = join(metadata.repository, 'apps/cli/package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh')
        return manifest;
    }
  }
  return undefined;
}

/** Project backend declarations using DSH's ordered bundle/profile/home patch semantics.
 * No module import, configuration expression evaluation, or profile initialization. */
export function dshNativeSource(home: string, profile: string, command?: string, args: readonly string[] = []) {
  const directory = join(home, 'profiles', profile),
    manifest = join(directory, 'package.json');
  const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } };
  const declared = metadata.dsh?.profile?.bundles;
  if (declared !== undefined && (!Array.isArray(declared) || !declared.every((name) => typeof name === 'string')))
    throw Error('dsh_config_invalid');
  const selected = command ?? resolveCliCommand('dsh');
  const installation = selected ? dshInstallation(selected, args) : undefined;
  const anchors = [...(installation ? [installation] : []), manifest];
  const entries = new Map<string, YAMLMap>();
  const apply = (file: string) => {
    if (!existsSync(file)) return;
    const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
    if (document.errors.length || !isSeq(document.contents)) throw Error('dsh_config_invalid');
    const visit = (rows: readonly unknown[]) =>
      rows.forEach((row) => {
        if (!isMap(row)) return;
        const inserted = row.get('insert', true);
        if (isSeq(inserted)) visit(inserted.items);
        const removed = row.get('remove');
        if (typeof removed === 'string' && ids.has(removed)) entries.delete(removed);
        const id = row.get('id');
        if (typeof id !== 'string' || !ids.has(id)) return;
        const existing = entries.get(id);
        if (existing && row.has('name') && row.get('name') !== existing.get('name')) return;
        const current = (existing?.clone() ?? row.clone()) as YAMLMap;
        if (row.has('config')) current.set('config', row.get('config', true));
        if (row.has('disabled')) {
          const disabled = row.get('disabled');
          if (typeof disabled !== 'boolean') throw Error('dsh_config_expression');
          current.set('disabled', disabled);
        }
        entries.set(id, current);
      });
    visit(document.contents.items);
  };
  (declared ?? []).forEach((name: string) => {
    // Match DSH's lookup even when package exports intentionally hide its manifest.
    const resolved = anchors
      .flatMap((anchor) => createRequire(anchor).resolve.paths(name) ?? [])
      .map((directory) => join(directory, name, 'package.json'))
      .find((file) => existsSync(file));
    if (!resolved) return; // DSH itself skips unavailable optional bundles.
    const bundle = JSON.parse(readFileSync(resolved, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } };
    const files = bundle.dsh?.bundle?.patch;
    const patches = typeof files === 'string' ? [files] : files;
    if (patches === undefined) return;
    if (!Array.isArray(patches) || !patches.every((path) => typeof path === 'string'))
      throw Error('dsh_bundle_unavailable');
    patches.forEach((file) => apply(resolve(dirname(resolved), file)));
  });
  apply(join(directory, 'cordis.patch.yml'));
  apply(join(home, 'cordis.patch.yml'));
  return stringify(
    [...entries.values()]
      .filter((row) => row.get('disabled') !== true)
      .map((row) => {
        const projected = row.clone() as YAMLMap;
        // Only the literal backend config is consumed by the shared boundary parser.
        [...projected.items].forEach((pair) => {
          if (!['id', 'config'].includes(String(pair.key))) projected.delete(pair.key);
        });
        return projected;
      }),
  );
}
