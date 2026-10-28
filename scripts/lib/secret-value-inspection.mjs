import { CONTEXTUAL_SECRET, isContextualCredential } from './secret-content-rules.mjs';
import { mergeSecretFindings, redactSecretContent, scanSecretContent } from './secret-content-scan.mjs';
import { decodeRasterPayload } from './secret-image-payload.mjs';

function inspectString(item, key, parent, rules, knownCredentials) {
  if (knownCredentials !== undefined) {
    const image = decodeRasterPayload(item, key, parent);
    if (image) {
      if (!knownCredentials.some((credential) => image.includes(Buffer.from(credential)))) return item;
      rules.add('known-credential');
      return '[credential-bearing image removed]';
    }
    let redacted = item;
    for (const credential of knownCredentials) {
      if (!redacted.includes(credential)) continue;
      rules.add('known-credential');
      redacted = redacted.replaceAll(credential, '[credential redacted]');
    }
    return redacted;
  }
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
  const image = decodeRasterPayload(item, key, parent);
  if (image) {
    const imageRules = new Set();
    // Scan decoded bytes for actual embedded credential text (e.g. metadata).
    // Never edit an image's encoding in place or exempt its neighboring text.
    redactChunks(image, imageRules);
    for (const rule of imageRules) rules.add(rule);
    return imageRules.size ? '[credential-bearing image removed]' : item;
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
export function inspectSecretValue(value, options = {}) {
  const knownCredentials =
    options.knownCredentials === undefined
      ? undefined
      : [
          ...new Set(
            options.knownCredentials.filter((credential) => typeof credential === 'string' && credential.length > 0),
          ),
        ].sort((a, b) => b.length - a.length);
  if (knownCredentials?.length === 0) return { value, rules: [] };
  const rules = new Set();
  let nodes = 0;
  let bytes = 0;
  function visit(item, key = '', depth = 0, parent = null) {
    if (++nodes > 100000 || depth > 64) throw new Error('secret_payload_uninspectable');
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > 64 * 1024 * 1024) throw new Error('secret_payload_uninspectable');
      return inspectString(item, key, parent, rules, knownCredentials);
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, key, depth + 1));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([name, child]) => {
        if (knownCredentials !== undefined)
          return [inspectString(name, '', null, rules, knownCredentials), visit(child, name, depth + 1, item)];
        const findings = scanSecretContent(name);
        for (const finding of findings) rules.add(finding.ruleId);
        return [redactSecretContent(name, findings), visit(child, name, depth + 1, item)];
      }),
    );
  }
  return { value: visit(value), rules: [...rules].sort() };
}
