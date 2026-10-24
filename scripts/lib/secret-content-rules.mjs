// Deliberately high-confidence formats. No test-directory, Markdown-fence or host exemptions.
export const SECRET_CONTENT_RULES = [
  { id: 'github-token', source: 'gh[pousr]_[A-Za-z0-9]{36}' },
  { id: 'github-fine-grained-token', source: 'github_pat_[A-Za-z0-9_]{22,255}' },
  { id: 'anthropic-token', source: 'sk-ant-(?:api[0-9]{2}|oat[0-9]{2})-[A-Za-z0-9_-]{20,1024}' },
  {
    id: 'provider-api-key',
    source: 'sk-(?:proj-|svcacct-|live-)[A-Za-z0-9_-]{32,1024}|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{32,1024}',
  },
  { id: 'google-api-key', source: 'AIza[0-9A-Za-z_-]{35}' },
  { id: 'groq-api-key', source: 'gsk_[A-Za-z0-9]{32,128}' },
  { id: 'slack-token', source: 'xox[baprs]-[0-9A-Za-z-]{20,255}' },
  {
    id: 'private-key',
    source:
      '-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\\r\\n]+[A-Za-z0-9+/=\\r\\n]{64,16384}-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
  },
];

export const CONTEXTUAL_SECRET =
  /\b(?:[a-z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|callback[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password|passwd)|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9_\-/.+=]{24,1024})(?![A-Za-z0-9_\-/.+=])/gi;

export function isContextualCredential(value) {
  // Full published variable names are metadata/placeholders, never a line-wide exemption.
  if (
    /^(?:CAT_CAFE(?:_[A-Z0-9_]+)?|ANTHROPIC|OPENROUTER|OPENAI|GOOGLE|GEMINI)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|CALLBACK_TOKEN)(?:_TEMPLATE)?$/.test(
      value,
    )
  )
    return false;
  if (/^(?:YOUR_(?:API_KEY|ACCESS_TOKEN|TOKEN|PASSWORD|SECRET)|REPLACE_ME|CHANGEME|PLACEHOLDER|EXAMPLE)$/i.test(value))
    return false;
  const frequencies = new Map();
  for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  const entropy = [...frequencies.values()].reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
  return entropy >= 3.5;
}

export function isContextualMatch(match) {
  const prefix = match[0].slice(0, -match[1].length);
  if (/["']\s*(?:Bearer\s+)?$/i.test(prefix) || /Bearer\s+$/i.test(prefix)) return isContextualCredential(match[1]);
  const key = prefix.split(/[:=]/)[0].replaceAll(/["'\s]/g, '');
  // Bare source identifiers/member expressions are not credential values. Real
  // JSON tool fields are inspected with their explicit field context separately.
  return (
    /^[A-Z][A-Z0-9_]+$/.test(key) &&
    !/^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+$/i.test(match[1]) &&
    isContextualCredential(match[1])
  );
}
