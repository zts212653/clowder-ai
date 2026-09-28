import { readFileSync } from 'node:fs';

/**
 * Agent-key credential resolution — the single semantic baseline shared by
 * the MCP server callback auth (resolveAgentKeySecret delegates here), the
 * readonly toolset union gate (parseToolsetEnv), the api-side union
 * synthesizers (antigravity McpToolExecutor + mcp-config adapters), and
 * callback routing.
 *
 * Semantics ported verbatim from the callback auth path so availability and
 * actual resolution cannot drift apart (#1494 round 2):
 *   1. A requested identity that mismatches the bound identity resolves nothing.
 *   2. With an effective identity (requested or
 *      CAT_CAFE_AGENT_KEY_BOUND_CAT_ID), ONLY that identity's variant-map
 *      entry counts — no SECRET/single-FILE fallback; an unrelated readable
 *      key never qualifies.
 *   3. A non-empty variant map without an effective identity resolves
 *      nothing at mount level (identities stay per-call selectable).
 *   4. Otherwise CAT_CAFE_AGENT_KEY_SECRET — non-blank after trim, returned
 *      verbatim (a whitespace-only secret is no material: HTTP header
 *      transport normalizes it to an empty value).
 *   5. Otherwise the single CAT_CAFE_AGENT_KEY_FILE sidecar, read at its
 *      LITERAL path (no trimming — the reader treats " path " as a filename).
 */

/** Read a sidecar key file; missing/unreadable/blank content → undefined. */
export function readAgentKeyFileSync(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || undefined;
  } catch {
    // sidecar missing = no agent-key (not an error)
    return undefined;
  }
}

/**
 * Parse the CAT_CAFE_AGENT_KEY_FILES JSON map. Bad JSON, non-objects, arrays,
 * and entries whose path is empty after trim are dropped; a fully invalid
 * payload yields {} (never throws).
 */
export function parseAgentKeyFileMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const files: Record<string, string> = {};
    for (const [catId, filePath] of Object.entries(parsed)) {
      if (typeof filePath === 'string' && filePath.trim()) {
        files[catId] = filePath.trim();
      }
    }
    return files;
  } catch {
    return {};
  }
}

/** A sidecar path counts as a credential only when it reads non-empty content. */
export function agentKeyFileUsable(path: string | undefined): boolean {
  return readAgentKeyFileSync(path) !== undefined;
}

export interface AgentKeyResolutionOptions {
  agentKeyCatId?: string | undefined;
}

/**
 * The callback-auth credential resolver, env-injected so tests and the
 * availability gate avoid process.env games. Returns the resolved secret, or
 * undefined when no credential is usable for the selected identity.
 */
export function resolveAgentKeySecretFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options?: AgentKeyResolutionOptions,
): string | undefined {
  const requestedCatId = options?.agentKeyCatId?.trim();
  const boundCatId = env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID?.trim();
  const variantMapRaw = env.CAT_CAFE_AGENT_KEY_FILES?.trim();
  if (requestedCatId && boundCatId && requestedCatId !== boundCatId) return undefined;

  const effectiveCatId = requestedCatId || boundCatId;
  if (effectiveCatId) {
    const variantFiles = parseAgentKeyFileMap(variantMapRaw);
    return readAgentKeyFileSync(variantFiles[effectiveCatId]);
  }

  if (variantMapRaw) return undefined;

  const agentKeySecret = env.CAT_CAFE_AGENT_KEY_SECRET;
  if (agentKeySecret?.trim()) return agentKeySecret;

  return readAgentKeyFileSync(env.CAT_CAFE_AGENT_KEY_FILE);
}

/**
 * Whether `env` carries at least one USABLE agent-key credential for this
 * mount. Every branch delegates to resolveAgentKeySecretFromEnv so the
 * bound-identity restriction, precedence, and normalization stay identical
 * to actual callback auth:
 *   - bound identity: only its own variant-map entry qualifies;
 *   - unbound shared map: any per-call selectable identity that resolves;
 *   - no map: the resolver's SECRET-then-single-FILE path (single-FILE path
 *     taken literally, matching the reader).
 */
export function hasUsableAgentKeyCredentials(env: Readonly<Record<string, string | undefined>>): boolean {
  const boundCatId = env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID?.trim();
  if (boundCatId) {
    return resolveAgentKeySecretFromEnv(env, { agentKeyCatId: boundCatId }) !== undefined;
  }
  const variantMapRaw = env.CAT_CAFE_AGENT_KEY_FILES?.trim();
  if (variantMapRaw) {
    return Object.keys(parseAgentKeyFileMap(variantMapRaw)).some(
      (catId) => resolveAgentKeySecretFromEnv(env, { agentKeyCatId: catId }) !== undefined,
    );
  }
  return resolveAgentKeySecretFromEnv(env) !== undefined;
}
