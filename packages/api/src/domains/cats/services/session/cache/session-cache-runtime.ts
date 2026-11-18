import { CAT_CARRIERS, type CatCarrier, catClientSupportsCarrier } from '@cat-cafe/shared';

/** Service telemetry names are distinct from the catalog's member access modes. */
const OBSERVED_CARRIERS: Readonly<Record<string, CatCarrier>> = {
  'anthropic:claude_print_sdk': 'cli',
  'anthropic:claude_agent_sdk': 'sdk',
  'openai:codex_exec_json': 'cli',
  'openai:codex_app_server': 'app_server',
  'google:agy_stream_json': 'cli',
  'google:agy_acp': 'acp',
  'kimi:kimi_stream_json': 'cli',
};

/** One cache identity vocabulary for provider observations and catalog/frozen expectations. */
export function sessionCacheRuntimeKey(
  input: { readonly clientId?: string; readonly carrier?: string } | undefined,
): string | undefined {
  if (!input?.clientId || !input.carrier) return undefined;
  const carrier =
    CAT_CARRIERS.find((candidate) => candidate === input.carrier) ??
    OBSERVED_CARRIERS[`${input.clientId}:${input.carrier}`];
  if (!carrier || !catClientSupportsCarrier(input.clientId, carrier)) return undefined;
  return `${input.clientId}:${carrier}`;
}
