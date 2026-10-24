import { CONTEXTUAL_SECRET, isContextualMatch, SECRET_CONTENT_RULES } from './secret-content-rules.mjs';

export const SECRET_SCAN_MAX_BYTES = 2 * 1024 * 1024;

// Findings carry positions, never matched bytes or a hash derived from a secret.
export function scanSecretContent(content, { maxBytes = SECRET_SCAN_MAX_BYTES } = {}) {
  const bytes = Buffer.from(content);
  if (bytes.length > maxBytes) throw new Error('secret_scan_size_limit');
  const text = bytes.toString('latin1');
  const candidates = [];
  for (const rule of SECRET_CONTENT_RULES) {
    for (const match of text.matchAll(new RegExp(rule.source, 'g'))) {
      candidates.push({ ruleId: rule.id, offset: match.index, length: match[0].length });
      if (candidates.length > 100) throw new Error('secret_scan_finding_limit');
    }
  }
  for (const match of text.matchAll(new RegExp(CONTEXTUAL_SECRET))) {
    if (isContextualMatch(match)) {
      candidates.push({
        ruleId: 'contextual-credential',
        offset: match.index + match[0].length - match[1].length,
        length: match[1].length,
      });
    }
    if (candidates.length > 100) throw new Error('secret_scan_finding_limit');
  }
  return mergeSecretFindings(candidates).map((candidate) => {
    const prefix = text.slice(0, candidate.offset);
    return {
      ...candidate,
      line: prefix.split('\n').length,
      column: candidate.offset - prefix.lastIndexOf('\n'),
    };
  });
}

/** Preserve the full extent when rules or overlapping windows observe a range again. */
export function mergeSecretFindings(candidates) {
  const findings = [];
  for (const candidate of candidates.sort((a, b) => a.offset - b.offset || b.length - a.length)) {
    const previous = findings.at(-1);
    if (previous && candidate.offset < previous.offset + previous.length) {
      previous.length = Math.max(previous.length, candidate.offset + candidate.length - previous.offset);
    } else findings.push({ ...candidate });
  }
  return findings;
}

/** Redact using byte offsets, preserving UTF-8 text outside the credential. */
export function redactSecretContent(content, findings = scanSecretContent(content)) {
  const bytes = Buffer.from(content);
  const parts = [];
  let offset = 0;
  for (const finding of findings) {
    parts.push(bytes.subarray(offset, finding.offset), Buffer.from('[credential redacted]'));
    offset = finding.offset + finding.length;
  }
  parts.push(bytes.subarray(offset));
  return Buffer.concat(parts).toString('utf8');
}
