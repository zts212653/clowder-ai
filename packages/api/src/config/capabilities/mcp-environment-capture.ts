import { resolveEnvReferences } from '../../utils/env-references.js';

/** Capture only documented environment/header fields. Commands and opaque provider options remain literal. */
export function captureMcpEnvironment<T extends Record<string, unknown>>(server: T): T {
  const captured: Record<string, Record<string, string>> = {};
  for (const field of ['env', 'environment', 'headers']) {
    const value = server[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entries = Object.entries(value);
    if (entries.every((entry): entry is [string, string] => typeof entry[1] === 'string'))
      captured[field] = resolveEnvReferences(Object.fromEntries(entries));
  }
  return { ...server, ...captured };
}
