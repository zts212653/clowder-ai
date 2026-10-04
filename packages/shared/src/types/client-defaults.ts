import type { ClientId } from './cat.js';
import { builtinAccountFamilyForRef } from './client-routing.js';

/**
 * One `clientDefaults[<ClientId>]` entry in cat-template.json — the per-client
 * runtime default menu that template-driven member creation reads (clowder-ai#768 P3).
 */
export interface ClientDefaultsEntry {
  readonly defaultModel: string;
  readonly models: readonly string[];
}

/**
 * Resolve the template defaults for one client.
 *
 * Canonical keys are {@link ClientId} values. Templates written before clowder-ai#768
 * keyed the same data by CLI/product name (`claude`/`codex`/`gemini`), and every project
 * keeps its own `cat-template.json`, so those legacy keys stay readable — resolved through
 * the existing builtin-account identity table rather than a second hand-kept alias map.
 *
 * Returns null when the client has no entry: callers must keep working without defaults.
 */
export function resolveClientDefaults(
  clientDefaults: Readonly<Record<string, ClientDefaultsEntry>> | null | undefined,
  client: ClientId,
): ClientDefaultsEntry | null {
  if (!clientDefaults) return null;
  if (Object.hasOwn(clientDefaults, client)) return clientDefaults[client] ?? null;
  for (const [key, entry] of Object.entries(clientDefaults)) {
    if (builtinAccountFamilyForRef(key) === client) return entry ?? null;
  }
  return null;
}
