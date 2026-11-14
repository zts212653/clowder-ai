import { z } from 'zod';
import { resolveEnvReferences } from '../utils/env-references.js';

/** Control-plane credentials and execution guards are Host-owned, including through aliases. */
function allowedName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^(CAT_CAFE_|CLOWDER_PLUGIN_|CODEX_CAT_)/i.test(name);
}

export const memberEnvironmentSchema = z.record(z.string(), z.string().max(16384)).superRefine((env, context) => {
  for (const [key, value] of Object.entries(env)) {
    const references = [...value.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]!);
    if (!allowedName(key) || references.some((name) => !allowedName(name)))
      context.addIssue({ code: 'custom', path: [key], message: 'member env must use ordinary environment names' });
  }
});

/** Generic member overrides precede the selected account adapter and its security finalizer. */
export function resolveMemberEnvironment(env?: Readonly<Record<string, string>>): Record<string, string> {
  return env ? resolveEnvReferences(memberEnvironmentSchema.parse(env), process.env, { hostOnly: true }) : {};
}
