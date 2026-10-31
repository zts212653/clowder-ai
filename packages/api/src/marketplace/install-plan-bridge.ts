import type { InstallPlan, McpInstallRequest } from '@cat-cafe/shared';

export function toMcpInstallRequest(plan: InstallPlan): McpInstallRequest {
  if (plan.mode !== 'direct_mcp') {
    throw new Error(`toMcpInstallRequest only supports direct_mcp plans, got "${plan.mode}"`);
  }
  if (!plan.mcpEntry) {
    throw new Error('direct_mcp plan is missing mcpEntry');
  }
  return { ...plan.mcpEntry };
}

export function validateInstallPlan(plan: InstallPlan): string[] {
  const errors: string[] = [];

  switch (plan.mode) {
    case 'direct_mcp':
      if (!plan.mcpEntry) errors.push('direct_mcp plan requires mcpEntry');
      break;
    case 'delegated_cli':
      if (!plan.delegatedCommand) errors.push('delegated_cli plan requires delegatedCommand');
      break;
    case 'manual_file':
    case 'manual_ui':
      if (!plan.manualSteps?.length) errors.push(`${plan.mode} plan requires manualSteps`);
      break;
  }

  return errors;
}
