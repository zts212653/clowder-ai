import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findMonorepoRoot } from '../../../../../../../utils/monorepo-root.js';
import type { AcpPermissionHandler } from '../AcpClient.js';
import type { AcpAgentRequest } from '../types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Official 1.4 SDK aliases are normalized once before the existing target policy.
// Conflicting aliases have no unambiguous target and therefore cannot authorize an effect.
function oneString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const present = keys.filter((key) => Object.hasOwn(args, key)).map((key) => args[key]);
  if (present.some((value) => typeof value !== 'string' || !value.trim())) return undefined;
  const values = new Set(present as string[]);
  return values.size === 1 ? [...values][0] : undefined;
}

const FILE_OPERATIONS = new Set([
  'write_file',
  'create_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);
const FILE_TARGET_KEYS = [
  'TargetFile',
  'target_file',
  'FilePath',
  'file_path',
  'AbsolutePath',
  'absolute_path',
  'path',
];

export const denyAgyAcpPermission: AcpPermissionHandler = (request, respond) => {
  const options = Array.isArray(request.params.options) ? request.params.options : [];
  const reject = options
    .map(record)
    .find((option) => option?.kind === 'reject_once' || option?.kind === 'reject_always');
  respond(typeof reject?.optionId === 'string' ? { optionId: reject.optionId } : { cancelled: true });
};

/** The wire description is input to shared target policy, never approval authority itself. */
export function createAgyAcpPermissionHandler(input: {
  sessionId: string;
  workspace: string;
  profileHome: string;
  autoApprove: boolean;
  readOnly: boolean;
  mcpServers: readonly string[];
  isActive(): boolean;
}): AcpPermissionHandler {
  return async (request: AcpAgentRequest, respond) => {
    const deny = () => denyAgyAcpPermission(request, respond);
    try {
      if (!input.isActive() || request.params.sessionId !== input.sessionId || input.readOnly) return deny();
      const call = record(request.params.toolCall);
      const args = record(call?.rawInput);
      if (!call || !args || typeof call.title !== 'string') return deny();
      const meta = record(call._meta);
      const mcp = record(meta?.mcp);
      let allowed = false;
      if (mcp) {
        // External tools keep their configured server/callback authority. No arbitrary
        // upstream server can borrow the invocation's host MCP credentials.
        allowed =
          typeof mcp.server === 'string' && input.mcpServers.includes(mcp.server) && typeof mcp.tool === 'string';
      } else {
        const name = call.kind === 'execute' ? 'run_command' : call.title.replace(/^Run /, '').replace(/\?$/, '');
        const normalized = {
          ...args,
          ...(call.kind === 'execute'
            ? { CommandLine: oneString(args, ['CommandLine', 'command_line', 'command']) }
            : {}),
          ...(FILE_OPERATIONS.has(name) ? { TargetFile: oneString(args, FILE_TARGET_KEYS) } : {}),
        };
        const guard = (await import(
          pathToFileURL(join(findMonorepoRoot(), 'scripts/agy-native-effect-guard.mjs')).href
        )) as {
          decideAgyNativeHookPayload(
            payload: unknown,
            options: { profileHome: string; readOnly: boolean },
          ): { decision: string };
        };
        const nativeName = ['write_file', 'create_file'].includes(name)
          ? 'write_to_file'
          : name === 'edit_file'
            ? 'replace_file_content'
            : name;
        allowed =
          guard.decideAgyNativeHookPayload(
            { toolCall: { name: nativeName, args: normalized }, workspacePaths: [input.workspace] },
            { profileHome: input.profileHome, readOnly: input.readOnly },
          ).decision === 'allow';
        // Restricted mode remains conservative for effects; reads and known
        // provider interactions retain the original Native behavior.
        if (!input.autoApprove && ['execute', 'edit', 'delete', 'move'].includes(String(call.kind))) allowed = false;
      }
      const options = Array.isArray(request.params.options) ? request.params.options : [];
      const allow = options.map(record).find((option) => option?.kind === 'allow_once');
      if (!allowed || !input.isActive() || typeof allow?.optionId !== 'string') return deny();
      respond({ optionId: allow.optionId });
    } catch {
      deny();
    }
  };
}
