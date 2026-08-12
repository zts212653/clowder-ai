export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

export interface CodexRuntimeSettings {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  authMode: CodexAuthMode;
}

export const CODEX_SANDBOX_OPTIONS: Array<{ value: CodexSandboxMode; label: string }> = [
  { value: 'read-only', label: 'read-only' },
  { value: 'workspace-write', label: 'workspace-write' },
  { value: 'danger-full-access', label: 'danger-full-access' },
];

export const CODEX_APPROVAL_OPTIONS: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: 'untrusted', label: 'untrusted' },
  { value: 'on-failure', label: 'on-failure' },
  { value: 'on-request', label: 'on-request' },
  { value: 'never', label: 'never' },
];

export const CODEX_AUTH_MODE_OPTIONS: Array<{ value: CodexAuthMode; label: string }> = [
  { value: 'oauth', label: 'oauth' },
  { value: 'api_key', label: 'api_key' },
  { value: 'auto', label: 'auto' },
];

export function toCodexRuntimeSettings(config?: {
  cli?: {
    codexSandboxMode?: CodexSandboxMode;
    codexApprovalPolicy?: CodexApprovalPolicy;
  };
  codexExecution?: {
    authMode?: CodexAuthMode;
  };
}): CodexRuntimeSettings {
  return {
    sandboxMode: config?.cli?.codexSandboxMode ?? 'workspace-write',
    approvalPolicy: config?.cli?.codexApprovalPolicy ?? 'on-request',
    authMode: config?.codexExecution?.authMode ?? 'oauth',
  };
}

export function buildCodexConfigPatches(
  settings: CodexRuntimeSettings,
  baseline: CodexRuntimeSettings,
): Array<{ key: string; value: string }> {
  const patches: Array<{ key: string; value: string }> = [];
  if (settings.sandboxMode !== baseline.sandboxMode) {
    patches.push({ key: 'cli.codexSandboxMode', value: settings.sandboxMode });
  }
  if (settings.approvalPolicy !== baseline.approvalPolicy) {
    patches.push({ key: 'cli.codexApprovalPolicy', value: settings.approvalPolicy });
  }
  if (settings.authMode !== baseline.authMode) {
    patches.push({ key: 'codex.execution.authMode', value: settings.authMode });
  }
  return patches;
}
