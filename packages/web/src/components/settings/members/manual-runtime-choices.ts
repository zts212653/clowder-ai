import type { RuntimeChoice } from './member-runtime-draft';
/** Detection enriches choices; it must never remove the original manual adapters. */
export const MANUAL_RUNTIME_CHOICES: RuntimeChoice[] = [
  ['anthropic', 'Claude Code'],
  ['openai', 'Codex'],
  ['google', 'AGY Native'],
  ['kimi', 'Kimi'],
  ['opencode', 'OpenCode'],
  ['catagent', 'Cat Agent'],
  ['acp', '自定义 ACP'],
].map(([clientId, label]) => ({
  id: `manual:${clientId}`,
  label,
  clientId: clientId as RuntimeChoice['clientId'],
  installed: false,
  models: [],
  ...(clientId === 'google' ? { agyCarrier: 'native' as const } : {}),
  ...(clientId === 'acp' ? { acp: { command: '', startupArgs: [] } } : {}),
}));
