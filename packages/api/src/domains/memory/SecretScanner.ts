export interface SecretFinding {
  type: string;
  file: string;
  line: number;
  snippet: string;
}

interface Pattern {
  type: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { type: 'aws-access-key', regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/ },
  { type: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { type: 'github-token', regex: /github_pat_[A-Za-z0-9_]{82}/ },
  { type: 'openai-key', regex: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { type: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9-]{90,}/ },
  { type: 'slack-token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { type: 'private-key', regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
];

const CODE_FENCE_RE = /^\s{0,3}[`~]{3,}/;
const PLACEHOLDER_RE = /EXAMPLE|PLACEHOLDER|YOUR[_-]|REPLACE|CHANGEME|xxx/i;

/**
 * The entropy fallback only applies to a real assignment shape: the credential-ish key must sit in
 * key position — line start behind an optional list bullet, quote, `export`/`const`-style keyword,
 * or a dotted/namespaced prefix (`cfg.apiKey =`). Prose that merely *mentions* a key
 * (e.g. "（correlation key = messageId/taskId/…）") is documentation, not an assignment.
 */
const ASSIGNMENT_KEY_RE =
  /^[\s>*\-•]*(?:(?:export|const|let|var|set)\s+)?(?:[\w$]+(?:\.[\w$]+|\[[^\]]*\])*\.)?["'`]?[\w.-]*(?:key|token|secret|password|credential|auth)[\w.-]*["'`]?\*{0,2}\s*[:=]/i;

/** `/`, `.`, `-` or `_`-joined runs of identifier/path segments (`messageId/taskId/sourceTool`, `docs/eval-domains/publish`) are enumerations, not secrets. */
const IDENTIFIER_CHAIN_RE = /^[A-Za-z][A-Za-z0-9_-]*(?:[/.][A-Za-z][A-Za-z0-9_-]*)+$/;

function isIdentifierEnumeration(value: string): boolean {
  // Only digit-free chains qualify: real high-entropy secrets almost always carry digits.
  return IDENTIFIER_CHAIN_RE.test(value) && !/\d/.test(value);
}

export class SecretScanner {
  static scan(content: string, filePath: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const lines = content.split(/\r?\n/);
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (CODE_FENCE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      let found = false;
      for (const pattern of PATTERNS) {
        const match = line.match(pattern.regex);
        if (match) {
          findings.push({
            type: pattern.type,
            file: filePath,
            line: i + 1,
            snippet: maskSecret(line.trim()),
          });
          found = true;
          break;
        }
      }

      if (!found && ASSIGNMENT_KEY_RE.test(line)) {
        const valueMatch = line.match(/[:=]\s*["']?([A-Za-z0-9_\-/.+=]{32,})["']?/);
        if (
          valueMatch &&
          !PLACEHOLDER_RE.test(valueMatch[1]) &&
          !isIdentifierEnumeration(valueMatch[1]) &&
          shannonEntropy(valueMatch[1]) > 3.5
        ) {
          findings.push({
            type: 'high-entropy-secret',
            file: filePath,
            line: i + 1,
            snippet: maskSecret(line.trim()),
          });
        }
      }
    }
    return findings;
  }

  static scanBatch(files: Array<{ path: string; content: string }>): {
    findings: SecretFinding[];
    filesWithSecrets: number;
  } {
    const findings: SecretFinding[] = [];
    let filesWithSecrets = 0;
    for (const file of files) {
      const fileFindings = SecretScanner.scan(file.content, file.path);
      if (fileFindings.length > 0) filesWithSecrets++;
      findings.push(...fileFindings);
    }
    return { findings, filesWithSecrets };
  }
}

function maskSecret(line: string): string {
  return line.replace(
    /[A-Za-z0-9_\-/.+=]{12,}/g,
    (match) => `${match.slice(0, 4)}${'*'.repeat(Math.min(match.length - 8, 16))}${match.slice(-4)}`,
  );
}

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
