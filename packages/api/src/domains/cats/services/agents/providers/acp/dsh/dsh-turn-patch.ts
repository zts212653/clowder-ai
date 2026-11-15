import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { stringify } from 'yaml';
import { z } from 'zod';
import { resolveCliCommandOrBare } from '../../../../../../../utils/cli-resolve.js';
import { resolveDshDesktopLaunch } from '../../../../../../../utils/dsh-desktop-launch.js';

const BRIDGE = secretRuntimeScript('dsh-turn-bridge.mjs');
// Startup admission pins the reviewed bridge bytes shipped by the existing runtime closure.
const BRIDGE_HASH = 'd13376ce64297de56d98e83cf6e8c4947c197cbe532cb0ea0826f85a9c381fb1';
const PREFIX = '# clowder-dsh-turn: ';
const selectionSchema = z.tuple([z.string().trim().min(1), z.string().trim().min(1)]);
const configSchema = z.object({
  nativeScope: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function template(config: z.infer<typeof configSchema>) {
  return (
    PREFIX +
    JSON.stringify(config) +
    '\n' +
    stringify([
      { id: 'acp', disabled: true },
      {
        insert: [
          {
            id: 'clowder-dsh-turn',
            name: pathToFileURL(BRIDGE).href,
            inject: ['acpAppStartup', 'catCafeSecretContent', 'credentials'],
            config,
          },
        ],
      },
    ])
  );
}

function resolveSupportedDshDesktopLaunch(command: string, args: readonly string[]) {
  const plan = resolveDshDesktopLaunch(resolveCliCommandOrBare(command), args);
  if (!plan) return null;
  const runtime: unknown = JSON.parse(
    readFileSync(join(dirname(plan.command), 'resources/runtime/primary-runtime/runtime.json'), 'utf8'),
  );
  return z.object({ desktopVersion: z.literal('0.2.2-rc.1') }).safeParse(runtime).success ? plan : null;
}

export function verifyDshTurnPatch(path: string, command: string, args: readonly string[]) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size >= 8192) return false;
    const content = readFileSync(path, 'utf8');
    if (!content.startsWith(PREFIX)) return false;
    const config = configSchema.parse(JSON.parse(content.slice(PREFIX.length, content.indexOf('\n'))));
    const plan = resolveSupportedDshDesktopLaunch(command, args);
    return (
      plan !== null &&
      config.nativeScope === dirname(dirname(dirname(plan.args[1]))) &&
      content === template(config) &&
      basename(path) === `dsh-turn-${digest(content)}.patch.yml` &&
      digest(readFileSync(BRIDGE)) === BRIDGE_HASH
    );
  } catch {
    return false;
  }
}

/** Only the tested Desktop carrier gains the private extension; saved member state is untouched. */
export async function prepareDshTurnPatch(
  command: string,
  args: string[],
  projectRoot: string,
  modelSelection?: string,
) {
  let config: z.infer<typeof configSchema>;
  try {
    const plan = resolveSupportedDshDesktopLaunch(command, args);
    if (!plan) return args;
    const [provider, model] = selectionSchema.parse(JSON.parse(modelSelection ?? 'null'));
    if (provider === 'unknown' || model === 'unknown') return args;
    config = { nativeScope: dirname(dirname(dirname(plan.args[1]))), provider, model };
  } catch {
    return args;
  }
  const content = template(config);
  const directory = join(projectRoot, '.cat-cafe/native-guards');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `dsh-turn-${digest(content)}.patch.yml`);
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!verifyDshTurnPatch(path, command, args)) throw new Error('dsh_turn_patch_changed');
  return [...args, '--patch', path];
}
