import type { SessionImplementationRef } from './implementation-registry.js';
export interface SessionContractSettings {
  mode: 'off' | 'plugin';
  bindings: ReadonlyMap<string, SessionImplementationRef>;
  warnings: readonly string[];
}
export function readSessionContractSettings(
  env: Readonly<Record<string, string | undefined>>,
): SessionContractSettings {
  const bindings = new Map<string, SessionImplementationRef>();
  const warnings: string[] = [];
  const mode = env.CAT_CAFE_AGENT_SESSION_CONTRACT || 'plugin';
  if (mode !== 'plugin') {
    if (mode && mode !== 'off') warnings.push('Invalid CAT_CAFE_AGENT_SESSION_CONTRACT; disabled');
    return { mode: 'off', bindings, warnings };
  }
  readBindings(env.CAT_CAFE_AGENT_SESSION_BINDINGS, bindings, warnings);
  return { mode: 'plugin', bindings, warnings };
}

function readBindings(raw: string | undefined, bindings: Map<string, SessionImplementationRef>, warnings: string[]) {
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
      for (const [catId, value] of Object.entries(parsed)) {
        const match = typeof value === 'string' ? /^plugin:([^/]+)\/([^/]+)$/.exec(value) : null;
        if (match) {
          const [, pluginId = '', contributionId = ''] = match;
          bindings.set(catId, { pluginId, contributionId });
        } else warnings.push(`Invalid session implementation binding for ${catId}`);
      }
    } catch {
      warnings.push('Invalid CAT_CAFE_AGENT_SESSION_BINDINGS; expected a JSON object');
    }
  }
}
