/** Internal / unstable: data only. The Host owns transport construction. */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { isExplicitAcpBootstrapRoot } from '../providers/acp/bootstrap/acp-bootstrap-inspect.js';
import type { SessionImplementationRef } from './implementation-registry.js';
export const AGENT_PROVIDER_DECLARATION_FILE = 'agent-provider.json';
const safeText = z
  .string()
  .max(8192)
  .regex(/^[^\u0000\r\n]*$/);
const acpSchema = z.strictObject({
  command: safeText.min(1),
  startupArgs: z.array(safeText).max(128),
  bootstrapRoot: safeText.min(1).refine(isExplicitAcpBootstrapRoot, '引导目录必须是本机绝对路径').optional(),
  mcpWhitelist: z.array(z.string()).optional(),
});
export interface AgentProviderDeclaration {
  id: string;
  name?: string;
  transport: 'acp';
  acp: z.infer<typeof acpSchema>;
}
export interface AgentClientLibraryDeclaration {
  configurationKey: string;
  presets?: AgentClientProfile[];
}
export type AgentProviderDeclarationResult =
  | { ok: true; declaration: AgentProviderDeclaration | AgentClientLibraryDeclaration }
  | { ok: false; code: 'invalid_declaration' | 'transport_not_allowed' | 'package_command_forbidden'; reason: string };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function parseAgentProviderDeclaration(
  raw: unknown,
  ctx: { packageRoot: string },
): AgentProviderDeclarationResult {
  const invalid = { ok: false, code: 'invalid_declaration', reason: 'Invalid agent provider declaration' } as const;
  if (record(raw) && 'configurationKey' in raw) {
    const library = z
      .strictObject({
        configurationKey: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
        presets: z.array(profileSchema).max(16).optional(),
      })
      .safeParse(raw);
    if (!library.success) return invalid;
    if (library.data.presets && !parseAgentClientProfiles(JSON.stringify(library.data.presets), ctx).ok) return invalid;
    return { ok: true, declaration: library.data };
  }
  if (!record(raw) || Object.keys(raw).some((key) => !['id', 'transport', 'acp'].includes(key))) return invalid;
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.id) || typeof raw.transport !== 'string')
    return invalid;
  if (raw.transport !== 'acp')
    return { ok: false, code: 'transport_not_allowed', reason: 'Only ACP transport is allowed' };
  if (!record(raw.acp)) return invalid;
  const parsed = acpSchema.safeParse(raw.acp);
  if (!parsed.success) return invalid;
  const inside = (path: string) => {
    const rel = relative(resolve(ctx.packageRoot), resolve(path));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };
  const { command, startupArgs } = parsed.data;
  if (
    (/[\\/]/.test(command) && (!isAbsolute(command) || inside(command))) ||
    startupArgs.some((arg) => isAbsolute(arg) && inside(arg))
  )
    return {
      ok: false,
      code: 'package_command_forbidden',
      reason: 'Package commands and package script arguments are forbidden',
    };
  return { ok: true, declaration: { id: raw.id, transport: 'acp', acp: parsed.data } };
}

const profileSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  name: safeText.min(1).max(100),
  ...acpSchema.shape,
});
export type AgentClientProfile = z.infer<typeof profileSchema>;
export function parseAgentClientProfiles(
  raw: unknown,
  ctx: { packageRoot: string },
): { ok: true; profiles: AgentProviderDeclaration[] } | { ok: false; reason: string } {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw new Error('客户端配置须为 64 KiB 以内的 JSON');
    const profiles = z.array(profileSchema).max(32).parse(JSON.parse(raw));
    const ids = new Set<string>();
    const declarations = profiles.map(({ id, name, ...acp }) => {
      if (ids.has(id)) throw new Error(`客户端 ID 重复：${id}`);
      ids.add(id);
      const parsed = parseAgentProviderDeclaration({ id, transport: 'acp', acp }, ctx);
      if (!parsed.ok) throw new Error(parsed.reason);
      return { id, name, transport: 'acp' as const, acp };
    });
    return { ok: true, profiles: declarations };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '客户端配置无效' };
  }
}

export function parsePluginAgentRef(value: unknown): SessionImplementationRef | undefined {
  const match =
    typeof value === 'string' ? /^plugin:([a-z0-9][a-z0-9._-]{0,127})\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(value) : null;
  return match ? { pluginId: match[1]!, contributionId: match[2]! } : undefined;
}

/** A saved choice is authoritative, including an invalid choice; legacy env is migration-only. */
export function resolveMemberSessionRef(
  saved: unknown,
  legacy: SessionImplementationRef | undefined,
  nested?: unknown,
): SessionImplementationRef | undefined {
  const choice = saved === undefined ? nested : saved;
  if (choice === undefined) return legacy;
  if (choice === null) return undefined;
  // These coordinates cannot be declared by a plugin manifest or provider schema.
  return parsePluginAgentRef(choice) ?? { pluginId: '!invalid', contributionId: '!invalid' };
}
