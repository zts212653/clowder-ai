import { CONTEXTUAL_SECRET, isContextualCredential } from './secret-content-rules.mjs';
import { mergeSecretFindings, redactSecretContent, scanSecretContent } from './secret-content-scan.mjs';

function inspectString(item, key, rules) {
  const prefix = `${key}: "`;
  const field = new RegExp(CONTEXTUAL_SECRET).exec(`${prefix}${item}"`);
  // Only the actual field name supplies structured credential context. A match
  // may begin within a namespaced/header key, but its value must be in item.
  // Matches wholly inside source text still use the ordinary content scanner.
  if (
    field &&
    field.index < key.length &&
    field.index + field[0].length - field[1].length >= prefix.length &&
    isContextualCredential(item)
  ) {
    rules.add('contextual-credential');
    return '[credential redacted]';
  }
  return redactChunks(Buffer.from(item), rules);
}

function redactChunks(bytes, rules) {
  const findings = [];
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    const start = Math.max(0, offset - 20000);
    const chunk = bytes.subarray(start, offset + 1024 * 1024);
    for (const finding of scanSecretContent(chunk)) {
      findings.push({ ...finding, offset: start + finding.offset });
      rules.add(finding.ruleId);
    }
  }
  return redactSecretContent(bytes, mergeSecretFindings(findings));
}

/** Inspect actual strings, never a JSON serialization that escapes private-key newlines. */
export function inspectSecretValue(value) {
  const rules = new Set();
  let nodes = 0;
  let bytes = 0;
  function visit(item, key = '', depth = 0) {
    if (++nodes > 100000 || depth > 64) throw new Error('secret_payload_uninspectable');
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > 64 * 1024 * 1024) throw new Error('secret_payload_uninspectable');
      return inspectString(item, key, rules);
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, key, depth + 1));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([name, child]) => {
        const findings = scanSecretContent(name);
        for (const finding of findings) rules.add(finding.ruleId);
        return [redactSecretContent(name, findings), visit(child, name, depth + 1)];
      }),
    );
  }
  return { value: visit(value), rules: [...rules].sort() };
}
