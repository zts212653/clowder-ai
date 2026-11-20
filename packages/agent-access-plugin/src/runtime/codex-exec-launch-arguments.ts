import type { AgentAccessCodexExecLaunch, AgentAccessCodexExecPlan } from '@clowder-ai/agent-contract';

/**
 * Codex exec argument planning.
 *
 * The Host resolves credentials, L0, MCP, images, sandbox/approval policy and
 * user overrides, then hands this module opaque group tokens in their required
 * precedence order. This module owns the CLI envelope and group order:
 * exec vs resume, --json, the stdin marker, and the order of the Host groups.
 *
 * App-server argv is intentionally absent: its long-lived process and private
 * RPC headers stay Host-owned.
 */
export function buildCodexExecLaunchArguments(input: AgentAccessCodexExecLaunch): AgentAccessCodexExecPlan {
  const args: string[] = input.sessionId ? ['exec', 'resume', input.sessionId, '--json'] : ['exec', '--json'];

  const groups = input.groups;
  if (groups.readOnly) args.push(groups.readOnly);
  if (groups.beforeSandbox) args.push(groups.beforeSandbox);
  if (groups.sandbox) args.push(groups.sandbox);
  if (groups.afterSandbox) args.push(groups.afterSandbox);
  if (groups.serviceTier) args.push(groups.serviceTier);
  if (groups.user) args.push(groups.user);
  if (groups.tail) args.push(groups.tail);

  args.push('--', '-');
  return {
    args,
    managedArgvFlags: [],
    output: { delta: 'delta', message: 'text', reasoningParts: 'summary', reasoningText: ['text', 'content'] },
  };
}
