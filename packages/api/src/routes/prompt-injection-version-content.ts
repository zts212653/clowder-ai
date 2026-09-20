import YAML from 'yaml';
import { getHookManifest, readSegmentSource } from './prompt-injection-hooks.js';

function sourcePlaceholders(content: string): Set<string> {
  return new Set([...content.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]));
}

/** Validate an operator-authored version against the canonical template contract. */
export function validateCanonicalVersionContent(hookId: string, content: string): string | null {
  if (!content.trim()) return 'content must not be empty';
  const manifest = getHookManifest(hookId);
  const canonical = readSegmentSource(hookId, false);
  if (!manifest || canonical === null) return `Canonical template source unavailable for segment ${hookId}`;
  const present = sourcePlaceholders(content);
  const missing = [...sourcePlaceholders(canonical)].filter((name) => !present.has(name));
  if (missing.length > 0) return `Missing required placeholders: ${missing.map((name) => `{{${name}}}`).join(', ')}`;
  if (!/\.ya?ml$/u.test(manifest.template)) return null;
  try {
    const parsed: unknown = YAML.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'YAML must be a mapping (object), not a scalar or list';
    }
    const invalid = Object.entries(parsed).find(([, value]) => typeof value !== 'string');
    return invalid ? `Value for key "${invalid[0]}" must be a string, got ${typeof invalid[1]}` : null;
  } catch (error) {
    return `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`;
  }
}
