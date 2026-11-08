import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';

const PLUGIN = secretRuntimeScript('secret-dsh-plugin.mjs');
// Startup admission covers this exact reviewed consumer, never arbitrary YAML or !!js.
const PLUGIN_HASH = 'a71c70ba186a43d991ce209761591f5e9d4474ea78af802eda8b6e48c13f2192';
const MODEL_PREFIX = '# clowder-acp-model: ';
function template(modelSelection?: string): string {
  let route: { provider: string; model: string } | undefined;
  if (modelSelection?.trim()) {
    try {
      const selection: unknown = JSON.parse(modelSelection);
      if (
        Array.isArray(selection) &&
        selection.length === 2 &&
        typeof selection[0] === 'string' &&
        selection[0].trim() &&
        typeof selection[1] === 'string' &&
        selection[1].trim() &&
        !selection.includes('unknown')
      )
        route = { provider: selection[0], model: selection[1] };
    } catch {
      // Existing DSH setups can expose bare model IDs; keep their native route.
    }
  }
  const selected = route ? `${MODEL_PREFIX}${JSON.stringify([route.provider, route.model])}\n` : '';
  const config = route ? `  config: ${JSON.stringify(route)}\n` : '';
  return `${selected}- insert:\n    - id: cat-cafe-secret-content\n      name: ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n- id: acp\n  inject: [acpAppStartup, catCafeSecretContent]\n${config}`;
}

function managedPatchName(content: string): string {
  const revision = createHash('sha256').update(content).digest('hex');
  return `secret-dsh-${revision}.patch.yml`;
}

async function waitForConcurrentPatchWrite(path: string): Promise<boolean> {
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    if (verifyDshSecretPatch(path)) return true;
    if (attempt < 10) await delay(10);
  }
  return false;
}

export function verifyDshSecretPatch(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size >= 4096) return false;
    const content = readFileSync(path, 'utf8');
    const selection = content.startsWith(MODEL_PREFIX)
      ? content.slice(MODEL_PREFIX.length, content.indexOf('\n'))
      : undefined;
    return (
      content === template(selection) &&
      basename(path) === managedPatchName(content) &&
      createHash('sha256').update(readFileSync(PLUGIN)).digest('hex') === PLUGIN_HASH
    );
  } catch {
    return false;
  }
}

function isDshLaunch(command: string, args: readonly string[], projectRoot: string): boolean {
  if (/^dsh(?:\.(?:cmd|exe|bat))?$/i.test(basename(command))) return true;
  if (!/^node(?:\.exe)?$/i.test(basename(command)) || !args[0]) return false;
  // Discovery may find an installed npm entry rather than a named dsh shim.
  try {
    const entry = realpathSync(resolve(projectRoot, args[0]));
    if (!/(?:^|[/\\])(?:lib|src)[/\\]bin\.(?:js|ts)$/.test(entry)) return false;
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'));
    return Boolean(
      manifest && typeof manifest === 'object' && 'name' in manifest && manifest.name === '@deepseek-ai/dsh',
    );
  } catch {
    return false;
  }
}

/** Pin DSH's handshake route without changing its native profile or credentials. */
export async function prepareDshSecretPatch(
  command: string,
  args: string[],
  projectRoot: string,
  modelSelection?: string,
): Promise<string[]> {
  if (!isDshLaunch(command, args, projectRoot)) return args;
  const directory = join(projectRoot, '.cat-cafe', 'native-guards');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const content = template(modelSelection);
  // The template contains the canonical Plugin URL. Addressing the managed file by
  // its complete content lets a reviewed path/template upgrade coexist with an old
  // deployment without overwriting a possibly user-modified guard file.
  const patch = join(directory, managedPatchName(content));
  let alreadyExists = false;
  try {
    await writeFile(patch, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('secret_dsh_patch_unavailable');
    alreadyExists = true;
  }
  // A concurrent creator exposes the new path before its tiny write finishes.
  // Wait only on EEXIST; a persistent mismatch still fails closed after 100 ms.
  const verified = alreadyExists ? await waitForConcurrentPatchWrite(patch) : verifyDshSecretPatch(patch);
  if (!verified) throw new Error('secret_dsh_patch_changed');
  return [...args, '--patch', patch];
}
