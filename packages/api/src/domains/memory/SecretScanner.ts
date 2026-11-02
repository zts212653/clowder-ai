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
const CREDENTIAL_NAME_RE = /(?:key|token|secret|password|credential|auth)$/i;
const DECLARATION_MODIFIERS = new Set([
  'export',
  'const',
  'let',
  'var',
  'readonly',
  'declare',
  'typeset',
  'local',
  'set',
  'env',
  'private',
  'protected',
  'public',
  'static',
]);

/** Consume targets, operators and values in order; never restart a regex inside a long name.
 * Quoted shell values stay one token, and a type annotation belongs to its preceding target.
 * Prose such as "correlation key = ..." has two targets without a declaration/assignment.
 */
function hasCredentialAssignment(line: string): boolean {
  const text = line.replace(/^[\s>*+\-•#|]*(?:\d+[.)]\s+|\[[ xX]\]\s+)*/, '');
  const tokens =
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|(?:\[[\w.]+\])?\$(?:\{[\w:.-]+\}|[\w:.-]+)|[\w.-]+:[\w.-]+(?=\s*=)|[\w.-]+|[^\s]/g;
  const valueAtOperator = /\s*["']?([A-Za-z0-9_\-/.+=]{32,})/y;
  let target = '';
  let validPrefix = true;
  let declaration = false;
  let annotation: { target: string; validPrefix: boolean } | undefined;
  let inValue = false;
  let valueStarted = false;
  let valueDepth = 0;
  let previousEnd = 0;

  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const word = token[0];
    // A completed RHS followed by whitespace permits the next shell assignment.
    // Keep operators visible for chained JS assignments; do not skip arbitrary RHS spans.
    if (inValue && valueStarted && valueDepth === 0 && token.index > previousEnd && word !== ':' && word !== '=') {
      target = '';
      validPrefix = true;
      declaration = false;
      annotation = undefined;
      inValue = false;
    }
    previousEnd = tokens.lastIndex;
    if (inValue) {
      if (word === '(' || word === '[') valueDepth++;
      if (word === ')' || word === ']') valueDepth = Math.max(0, valueDepth - 1);
      valueStarted = true;
    }
    if (word === ':' || word === '=') {
      if (annotation && word === ':') {
        annotation.validPrefix = false;
        continue;
      }
      const assignment = annotation ?? { target, validPrefix };
      // := is a single operator, not a type annotation followed by another assignment.
      const valueStart = tokens.lastIndex + (word === ':' && text[tokens.lastIndex] === '=' ? 1 : 0);
      valueAtOperator.lastIndex = valueStart;
      const value = valueAtOperator.exec(text)?.[1];
      if (
        assignment.validPrefix &&
        CREDENTIAL_NAME_RE.test(assignment.target.replace(/["'}]$/, '')) &&
        value &&
        !PLACEHOLDER_RE.test(value) &&
        shannonEntropy(value) > 3.5
      )
        return true;
      if (word === ':' && valueStart === tokens.lastIndex) {
        annotation ??= assignment;
      } else {
        tokens.lastIndex = valueStart;
        target = '';
        validPrefix = true;
        declaration = false;
        annotation = undefined;
        inValue = true;
        valueStarted = false;
      }
      continue;
    }
    if (word === ';' || word === ',' || word === '{' || word === '}' || word === '|' || word === '(' || word === ')') {
      if (annotation && word === '|') continue;
      target = '';
      validPrefix = true;
      declaration = false;
      annotation = undefined;
      if (word !== '(' && word !== ')') {
        inValue = false;
        valueDepth = 0;
      }
      continue;
    }
    if (annotation) {
      // A URL/path is not a TS type and must not borrow a later '=' value.
      if (!/^[\w$<>&|.,?[\]]+$/.test(word)) annotation.validPrefix = false;
      continue;
    }
    if (DECLARATION_MODIFIERS.has(word) || (declaration && /^--?[A-Za-z][\w-]*$/.test(word))) {
      if (target) validPrefix = false;
      declaration = true;
      continue;
    }
    if (target) validPrefix = false;
    target = word;
  }
  return false;
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

      if (!found && hasCredentialAssignment(line)) {
        findings.push({
          type: 'high-entropy-secret',
          file: filePath,
          line: i + 1,
          snippet: maskSecret(line.trim()),
        });
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
