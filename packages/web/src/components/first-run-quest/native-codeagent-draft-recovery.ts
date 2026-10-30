import type { NativePartner } from './native-onboarding';

const roles = new Set(['ragdoll', 'maine-coon', 'turkish-van']);
function codeagentRole(partner: NativePartner): string | undefined {
  const runtime = partner.runtime,
    role = runtime.roleTemplateId;
  if (!role || !roles.has(role) || partner.form.acpAgentProvider || runtime.acp?.agentProvider) return undefined;
  if (runtime.id === 'codeagent' && runtime.harnessId === 'codeagent') return `codeagent:${role}`;
  return runtime.id === `codeagent:${role}` && (!runtime.harnessId || runtime.harnessId === 'codeagent')
    ? `codeagent:${role}`
    : undefined;
}

/** Preserve pending role identity through missing-CLI catalog upgrades; runtime availability stays server-owned. */
export function retainedCodeagentDraft(partner: NativePartner, previous: NativePartner[] = []) {
  if (partner.runtime.id !== 'codeagent' || partner.runtime.harnessId !== 'codeagent') return undefined;
  const roleKey = codeagentRole(partner);
  if (!roleKey) return undefined;
  const matches = previous.filter(
    (old) =>
      codeagentRole(old) === roleKey &&
      (!partner.runtime.installed || !old.runtime.installed || old.retainedCodeagentRole === roleKey),
  );
  return matches.length === 1 ? { previous: matches[0], roleKey } : undefined;
}
