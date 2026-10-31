import type { SkillPermissionSet, SkillSecurityStatus } from '@cat-cafe/shared';

interface PermissionContext {
  isExternal: boolean;
  firstRun?: boolean;
  status?: SkillSecurityStatus;
}

interface ToolPermissionResult {
  requiresConfirmation: boolean;
  risk: 'high' | 'low';
}

const HIGH_RISK_VERBS = [
  'write',
  'delete',
  'remove',
  'execute',
  'run',
  'send',
  'post',
  'push',
  'deploy',
  'install',
  'create',
  'update',
  'modify',
  'drop',
  'kill',
  'terminate',
  'publish',
];

function extractEffectiveName(toolName: string): string {
  const parts = toolName.split('__');
  return parts.length > 1 ? parts[parts.length - 1] : toolName;
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function isHighRiskTool(toolName: string): boolean {
  const effective = camelToSnake(extractEffectiveName(toolName));
  return HIGH_RISK_VERBS.some((verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`).test(effective));
}

export function getSkillPermissions(ctx: PermissionContext): SkillPermissionSet {
  if (!ctx.isExternal) {
    return { canWriteCapabilities: true, canTriggerSkills: true, toolAutoAllow: true, mode: 'full' };
  }

  let mode: SkillPermissionSet['mode'] = 'read-only';
  if (ctx.firstRun) mode = 'dry-run';

  return {
    canWriteCapabilities: false,
    canTriggerSkills: false,
    toolAutoAllow: false,
    mode,
  };
}

export function checkToolPermission(toolName: string, ctx: PermissionContext): ToolPermissionResult {
  if (!ctx.isExternal) {
    return { requiresConfirmation: false, risk: isHighRiskTool(toolName) ? 'high' : 'low' };
  }

  const risk = isHighRiskTool(toolName) ? 'high' : 'low';
  const requiresConfirmation = risk === 'high' || ctx.status !== 'approved';

  return { requiresConfirmation, risk };
}
