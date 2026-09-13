/**
 * ZCode has no official ACP command. Hub generic ACP talks to an in-repo
 * adapter that drives `zcode app-server` (private JSON-RPC, no `jsonrpc` field).
 * Catalog identity stays `zcode`; spawn never sends ACP frames to zcode itself.
 * Missing binary → skip the member.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../../utils/cli-resolve.js';
import { diagnoseZcodeSpawnReady, ensureZcodeIsolatedHome, resolveZcodeIsolatedHome } from './zcode-acp-protocol.js';

export { diagnoseZcodeSpawnReady, ensureZcodeIsolatedHome, resolveZcodeIsolatedHome };

const ZCODE_HARNESS_BASENAMES = new Set(['zcode']);
const MAC_APP_ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const LINUX_APP_ZCODE = '/opt/ZCode/app/resources/glm/zcode.cjs';

export function isZcodeHarnessCommand(command: string): boolean {
  return ZCODE_HARNESS_BASENAMES.has(basenameCommand(command));
}

export function zcodeOmitsAcpSessionMcp(command: string): boolean {
  return isZcodeHarnessCommand(command);
}

export type ZcodeAcpStdioSpawnResult =
  | { ok: true; command: string; args: string[]; env: Record<string, string>; bin: string }
  | { ok: false; error: Error };

export function resolveZcodeAcpAdapterPath(fromUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(fromUrl)), 'zcode-acp-adapter.js');
}

export function resolveZcodeBin(
  env: NodeJS.ProcessEnv = process.env,
  bundledCandidates: readonly string[] = [MAC_APP_ZCODE, LINUX_APP_ZCODE],
): string | undefined {
  const override = env.CAT_CAFE_ZCODE_BIN?.trim();
  if (override && existsSync(override)) return override;
  const pathHit = resolveCliCommand('zcode');
  if (pathHit) return pathHit;
  if (env.CAT_CAFE_ZCODE_IGNORE_BUNDLED === '1') return undefined;
  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function applyZcodeHarnessSpawn<
  T extends { command: string; args: string[]; extraEnv?: Record<string, string>; model?: string },
>(bootstrap: T, command: string): { ok: true; bootstrap: T } | { ok: false; error: Error } {
  if (!isZcodeHarnessCommand(command)) return { ok: true, bootstrap };
  const prepared = prepareZcodeAcpSpawn({
    command,
    env: { ...process.env, ...bootstrap.extraEnv },
  });
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    bootstrap: {
      ...bootstrap,
      command: prepared.command,
      args: prepared.args,
      extraEnv: {
        ...prepared.env,
        ...(bootstrap.model ? { ZCODE_MODEL: bootstrap.model } : {}),
      },
    },
  };
}

export function zcodeUnreadyMessage(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!isZcodeHarnessCommand(command)) return undefined;
  const ready = diagnoseZcodeSpawnReady(env);
  return ready.ok ? undefined : ready.error.message;
}

export function prepareZcodeAcpSpawn(input: {
  command: string;
  env?: NodeJS.ProcessEnv;
  adapterUrl?: string;
}): ZcodeAcpStdioSpawnResult {
  if (!isZcodeHarnessCommand(input.command)) {
    return { ok: false, error: new Error(`not a ZCode harness command: ${input.command}`) };
  }
  const bin = resolveZcodeBin(input.env);
  if (!bin) {
    return {
      ok: false,
      error: new Error(
        `${formatCliNotFoundError('zcode')} Or set CAT_CAFE_ZCODE_BIN to the bundled zcode.cjs (macOS: ${MAC_APP_ZCODE}).`,
      ),
    };
  }
  const adapterPath = resolveZcodeAcpAdapterPath(input.adapterUrl);
  if (!existsSync(adapterPath)) {
    return {
      ok: false,
      error: new Error(`ZCode ACP adapter missing at ${adapterPath}. Build the API package first.`),
    };
  }
  const isolatedHome = ensureZcodeIsolatedHome(resolveZcodeIsolatedHome(input.env ?? process.env));
  return {
    ok: true,
    command: process.execPath,
    args: [adapterPath],
    env: { ZCODE_BIN: bin, CAT_CAFE_ZCODE_HOME: isolatedHome },
    bin,
  };
}

function basenameCommand(command: string): string {
  const trimmed = command.trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).replace(/\.(cjs|js)$/i, '');
}
