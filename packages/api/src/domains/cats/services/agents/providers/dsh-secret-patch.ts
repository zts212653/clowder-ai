import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';

const PLUGIN = secretRuntimeScript('secret-dsh-plugin.mjs');
// Startup admission covers this exact reviewed consumer, never arbitrary YAML or !!js.
const PLUGIN_HASH = 'c34e9b909d42d44f52d4742fcd7e94679cacd65e26f8743403121521628c8901';
const template = () =>
  `- insert:\n    - id: cat-cafe-secret-content\n      name: ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n- id: acp\n  inject: [acpAppStartup, catCafeSecretContent]\n`;

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
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size < 4096 &&
      readFileSync(path, 'utf8') === template() &&
      createHash('sha256').update(readFileSync(PLUGIN)).digest('hex') === PLUGIN_HASH
    );
  } catch {
    return false;
  }
}

/** An explicit final patch leaves the native DSH home/profile and OAuth state intact. */
export async function prepareDshSecretPatch(command: string, args: string[], projectRoot: string): Promise<string[]> {
  if (!/^dsh(?:\.(?:cmd|exe|bat))?$/i.test(basename(command))) return args;
  const directory = join(projectRoot, '.cat-cafe', 'native-guards');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const content = template();
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
