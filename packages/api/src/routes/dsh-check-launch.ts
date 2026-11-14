import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { DSH_DESKTOP_RUNTIME } from './dsh-desktop-runtime.js';
import type { DshSetupLaunch } from './dsh-setup-launch.js';

export const DSH_CHECK_GUARD = String.raw`
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => 'clowder_connection_check_tools_disabled');
  ctx.provide('clowderConnectionCheckReady', true);
}
`;

// Only the managed Desktop composition is checked. This is not an arbitrary
// user-plugin sandbox: those launches retain their existing manual behavior.
const patchSchema = z.array(
  z.union([
    z
      .object({
        id: z.enum(['credentials', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'acp']),
        disabled: z.boolean().optional(),
        inject: z.array(z.string()).optional(),
        config: z.record(z.unknown()).optional(),
      })
      .strict(),
    z
      .object({
        insert: z
          .array(
            z
              .object({
                id: z.literal('clowder-desktop-credentials'),
                name: z.string(),
                config: z.record(z.unknown()),
              })
              .strict(),
          )
          .length(1),
      })
      .strict(),
  ]),
);

/** Read the saved binding without creating a HOME or starting a model request. */
export function readDshCheckBinding(launch: Pick<DshSetupLaunch, 'command' | 'args' | 'cwd' | 'env'>) {
  const patchIndex = launch.args.indexOf('--patch');
  if (patchIndex < 0 || !launch.args[patchIndex + 1]) throw Error('dsh_setup_profile_required');
  if (launch.args.lastIndexOf('--patch') !== patchIndex) throw Error('dsh_setup_custom_startup');
  const patchText = readFileSync(launch.args[patchIndex + 1]!, 'utf8');
  const parsed = patchSchema.safeParse(parse(patchText));
  if (!parsed.success) throw Error('dsh_setup_custom_startup');
  const bridges = parsed.data.flatMap((row) => ('insert' in row ? row.insert : []));
  const acp = parsed.data.flatMap((row) => ('id' in row && row.id === 'acp' ? [row] : []));
  if (acp.length !== 1) throw Error('dsh_setup_changed');
  if (bridges.length !== 1 || readFileSync(fileURLToPath(bridges[0]?.name), 'utf8') !== DSH_DESKTOP_RUNTIME)
    throw Error('dsh_setup_changed');
  const source = z.object({ nativeHome: z.string(), nativeCwd: z.string() }).parse(bridges[0]?.config);
  const route = z.object({ provider: z.string().min(1), model: z.string().min(1) }).parse(acp[0]?.config);
  return {
    launch,
    patchIndex,
    patch: parsed.data,
    patchText,
    route,
    source: { ...source, command: launch.command, cwd: launch.cwd },
  };
}

/** Own a short-lived check HOME/cwd; never run the member's mutable plugin code. */
export function createDshCheckLaunch(binding: ReturnType<typeof readDshCheckBinding>) {
  const { launch, patchIndex, patch } = binding;
  const directory = mkdtempSync(join(tmpdir(), 'dsh-connection-check-'));
  const home = join(directory, 'home');
  const cwd = join(directory, 'workspace');
  mkdirSync(home);
  mkdirSync(cwd);
  const guardPath = join(directory, 'guard.mjs');
  writeFileSync(guardPath, DSH_CHECK_GUARD, { mode: 0o600 });
  const path = join(directory, 'check.patch.yml');
  writeFileSync(
    path,
    stringify([
      ...patch.map((row) =>
        'id' in row && row.id === 'acp'
          ? { ...row, inject: [...new Set([...(row.inject ?? []), 'clowderConnectionCheckReady'])] }
          : row,
      ),
      { insert: [{ id: 'clowder-check-guard', name: pathToFileURL(guardPath).href }] },
    ]),
    { mode: 0o600 },
  );
  const args = launch.args.map((value, index) => (index === patchIndex + 1 ? path : value));
  return {
    directory,
    launch: { ...launch, args, cwd, env: { ...launch.env, DSH_HOME: home } },
    // directory is the exact absolute mkdtemp result owned by this check.
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
