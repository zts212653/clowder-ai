export type CodexApprovalSurface = 'interactive' | 'unavailable';

export type CodexAppApprovalFailureCode = 'user_rejected' | 'confirmation_unavailable';

export interface CodexAppApprovalFailure {
  reasonCode: CodexAppApprovalFailureCode;
  message: string;
}

const UPSTREAM_USER_REJECTED = 'user rejected MCP tool call';

/**
 * Clowder AI has no request/response surface for Codex App confirmations today.
 * Keep writes gated in Codex and route already-authorized GitHub mutations through
 * the repository's audited CLI workflow instead of weakening Apps permissions.
 */
export const CODEX_APPS_WRITE_APPROVAL_ARGS = [
  '--config',
  'apps._default.default_tools_approval_mode="writes"',
] as const;

export const CAT_CAFE_GITHUB_ROUTING_INSTRUCTIONS = `# Clowder AI GitHub routing

- GitHub MCP and GitHub App tools are retired for repository operations in Clowder AI. Do not install or invoke them.
- Use the repository's canonical \`gh\` CLI path for both reads and writes.
- This changes transport only; it does not grant authority. Continue to follow merge-gate, review, operator, and irreversible-operation boundaries.`;

export const CAT_CAFE_GITHUB_WRITE_ROUTING_INSTRUCTIONS = `

This host has no interactive approval surface for GitHub App write confirmations.
- If the canonical path needs new human authority or cannot run, return \`confirmation_unavailable\` with the exact missing authority or actionable command.
- In this host mode, the upstream literal \`user rejected MCP tool call\` means confirmation was unavailable; it is not evidence that a person rejected the action.`;

export function appendCatCafeGithubWriteRouting(
  developerInstructions: string,
  approvalSurface: CodexApprovalSurface,
): string {
  const base = `${developerInstructions.trimEnd()}\n\n${CAT_CAFE_GITHUB_ROUTING_INSTRUCTIONS}\n`;
  if (approvalSurface !== 'unavailable') return base;
  return `${base.trimEnd()}\n${CAT_CAFE_GITHUB_WRITE_ROUTING_INSTRUCTIONS}\n`;
}

function isGithubAppTool(server: string, tool: string): boolean {
  return server === 'codex_apps' && /^github(?:[._/]|$)/i.test(tool);
}

/**
 * Upstream currently collapses an approval decline with no message into one
 * literal. The host capability is the missing provenance needed to distinguish
 * a real interactive rejection from a non-interactive synthetic decline.
 */
export function classifyCodexGithubAppApprovalFailure(input: {
  server: string;
  tool: string;
  error: string;
  approvalSurface?: CodexApprovalSurface;
}): CodexAppApprovalFailure | null {
  if (!input.approvalSurface) return null;
  if (!isGithubAppTool(input.server, input.tool)) return null;
  if (input.error.trim() !== UPSTREAM_USER_REJECTED) return null;

  if (input.approvalSurface === 'unavailable') {
    return {
      reasonCode: 'confirmation_unavailable',
      message:
        'GitHub App confirmation is unavailable in this Clowder AI invocation. Use the canonical gh CLI under merge-gate when the write is already authorized; otherwise report the exact missing authority. No permission was expanded.',
    };
  }

  return {
    reasonCode: 'user_rejected',
    message: 'The interactive user rejected the GitHub App tool call.',
  };
}
