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
 * The entropy fallback runs only on a single **assignment** shape, matched as one unit so the key and
 * its value always share the same operator:
 *
 * - the key must be the assignment *target* token — decoration is unconstrained
 *   (`$NAME`, `${NAME}`, `$scope:NAME`, `${scope:NAME}`, `[string]$NAME`, `cfg.apiKey`, `"NAME"`),
 *   because everything between the leading markers/keyword prefix and the operator must be one
 *   whitespace-free token. Prose fails here: in "（correlation key = messageId/taskId/…）" the key is
 *   preceded by whitespace-separated words;
 * - leading Markdown decoration is allowed (`>`, `*`, `-`, `+`, `#`, `|`, `•`, ordered lists and
 *   `[ ]`/`[x]` task boxes) plus shell/JS keyword prefixes (`export`, `readonly`, `declare -x`,
 *   `const`, …) and preceding `NAME=value` assignments, so `1. api_key = …`, `# api_key = …` and
 *   `FOO=1 API_TOKEN=…` stay in scope;
 * - the value must belong to **that** operator, not to any `[:=]` later on the line. Scanning the
 *   line for any operator reported documentation links as secrets: in `api_key: https://host/…` the
 *   `:` of `https:` supplied a 32+ character "value" and tripped the fail-closed purge. A typed
 *   declaration (`API_TOKEN: string = …`) and the `:=` operator are still accepted, but the typed
 *   form only accepts a type-ish run (no `/`, `?`, `:`) so a URL cannot reach an `=` through it.
 *
 * No value shape is blanket-exempted: a passphrase like "CorrectHorse/BatteryStaple/…" is
 * indistinguishable from an identifier enumeration, so only the entropy threshold applies.
 */
const ASSIGNMENT_VALUE_RE =
  /^[\s>*+\-•#|]*(?:\d+[.)]\s+|\[[ xX]\]\s+)*(?:(?:export|readonly|declare|typeset|local|set|env|const|let|var)(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+|[A-Za-z_]\w*=\S*\s+)*[^\s]*?(?:key|token|secret|password|credential|auth)[^\s]*?\s*(?:[:=]+\s*|:\s*[\w$<>\[\]|.,\s]+?=\s*)["']?([A-Za-z0-9_\-/.+=]{32,})["']?/i;

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

      if (!found) {
        const assignment = ASSIGNMENT_VALUE_RE.exec(line);
        const value = assignment?.[1];
        if (value !== undefined && !PLACEHOLDER_RE.test(value) && shannonEntropy(value) > 3.5) {
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
