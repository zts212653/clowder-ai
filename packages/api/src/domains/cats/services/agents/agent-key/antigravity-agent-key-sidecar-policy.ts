export type AgentKeyRegistryBackendKind = 'memory' | 'redis';

export interface AntigravityAgentKeySidecarPolicyOptions {
  backendKind: AgentKeyRegistryBackendKind;
  env?: Record<string, string | undefined>;
}

export function shouldProvisionAntigravityAgentKeySidecar({
  backendKind,
  env = process.env,
}: AntigravityAgentKeySidecarPolicyOptions): boolean {
  if (env.CAT_CAFE_AGENT_KEY_SIDECAR_DISABLED === '1') return false;
  if (env.CAT_CAFE_PROVISION_GLOBAL_SIDECAR !== '1') return false;
  if (backendKind === 'redis') return true;
  return env.CAT_CAFE_AGENT_KEY_ALLOW_MEMORY_SIDECAR === '1';
}
