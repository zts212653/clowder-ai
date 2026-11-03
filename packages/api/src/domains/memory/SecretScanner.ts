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
  const text = line
    .replace(/^[\s>*+\-•#|]*(?:\d+[.)]\s+|\[[ xX]\]\s+)*/, '')
    // cmd quotes the entire NAME=value, unlike quotes belonging to a shell RHS.
    .replace(/(^|[;&|()])(\s*set\s+)"([^"\r\n]*)"(?=\s*(?:$|[;&|()]))/gi, '$1$2$3');
  const tokens =
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|(?:\[[\w.]+\])?\$(?:\{[\w:.-]+\}|[\w:.-]+)|[\w.-]+:[\w.-]+(?=\s*=)|[\w.-]+|[^\s]/g;
  const valuePrefix = /\s*["']?/y;
  const valueRun = /[A-Za-z0-9_\-/.+=]+/y;
  const declarationStart = /\s*(?=[A-Za-z_$[{])/y;
  const modifierStart = /\s*(?=[^\s:])/y;
  const declarationDepths: number[] = [];
  let syntaxDepth = 0;
  let target = '';
  let validPrefix = true;
  let declaration = false;
  let typedDeclaration = false;
  let annotation: { target: string; validPrefix: boolean } | undefined;
  let annotationDepth = 0;
  let inValue = false;
  let valueStarted = false;
  let valueDepth = 0;
  let previousEnd = 0;
  let candidateStart = 0;
  let candidateEnd = 0;
  let lastPlaceholder = -1;
  const counts = new Map<string, number>();

  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    let word = token[0];
    if (word === ')' || word === ']' || word === '}') syntaxDepth = Math.max(0, syntaxDepth - 1);
    while (declarationDepths.length > 0 && declarationDepths[declarationDepths.length - 1] > syntaxDepth) {
      declarationDepths.pop();
    }
    if (word === ';' && declarationDepths.at(-1) === syntaxDepth) declarationDepths.pop();
    if (word === '(' || word === '[' || word === '{') syntaxDepth++;
    // In a JS/TS declaration this colon starts a type, not a shell namespace.
    if (typedDeclaration && /^[\w$.-]+:[\w$.-]*$/.test(word)) {
      const colon = word.indexOf(':');
      word = word.slice(0, colon);
      tokens.lastIndex = token.index + colon;
    }
    // A completed RHS followed by whitespace permits the next shell assignment.
    // Keep operators visible for chained JS assignments; do not skip arbitrary RHS spans.
    if (inValue && valueStarted && valueDepth === 0 && token.index > previousEnd && word !== ':' && word !== '=') {
      target = '';
      validPrefix = true;
      declaration = false;
      typedDeclaration = false;
      annotation = undefined;
      inValue = false;
    }
    previousEnd = tokens.lastIndex;
    if (inValue) {
      if (word === '(' || word === '[') valueDepth++;
      if (word === ')' || word === ']') valueDepth = Math.max(0, valueDepth - 1);
      valueStarted = true;
    }
    if (annotation) {
      // Nested type bodies and arrows cannot end the captured declaration.
      if (word === '=' && text[tokens.lastIndex] === '>') {
        tokens.lastIndex++;
        continue;
      }
      if (word === '<' || word === '(' || word === '[' || (typedDeclaration && word === '{')) {
        annotationDepth++;
        continue;
      }
      if (annotationDepth > 0 && (word === '>' || word === ')' || word === ']' || (typedDeclaration && word === '}'))) {
        annotationDepth--;
        continue;
      }
      if (annotationDepth > 0 && (typedDeclaration || word === ',' || word === ':')) continue;
    }
    if (word === ':' || word === '=') {
      if (word === ':' && typedDeclaration) {
        annotation ??= { target, validPrefix };
        annotationDepth = 0;
        continue;
      }
      if (annotation && word === ':') {
        annotation.validPrefix = false;
        continue;
      }
      const assignment = annotation ?? { target, validPrefix };
      // := is a single operator, not a type annotation followed by another assignment.
      const valueStart = tokens.lastIndex + (word === ':' && text[tokens.lastIndex] === '=' ? 1 : 0);
      if (assignment.validPrefix && CREDENTIAL_NAME_RE.test(assignment.target.replace(/["'}]$/, ''))) {
        valuePrefix.lastIndex = valueStart;
        valuePrefix.exec(text);
        const start = valuePrefix.lastIndex;
        if (start >= candidateEnd) {
          valueRun.lastIndex = start;
          const value = valueRun.exec(text)?.[0] ?? '';
          candidateStart = start;
          candidateEnd = start + value.length;
          counts.clear();
          for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
          lastPlaceholder = -1;
          // Lookahead also records overlapping placeholders (e.g. xxxx).
          const placeholders = new RegExp(`(?=${PLACEHOLDER_RE.source})`, 'gi');
          for (const placeholder of value.matchAll(placeholders)) lastPlaceholder = start + placeholder.index;
        }
        // Operators inside the same value run reuse its counts. Each character is
        // added and removed once, including adversarial key=key=... suffixes.
        while (candidateStart < start && candidateStart < candidateEnd) {
          const ch = text[candidateStart++];
          const count = counts.get(ch)! - 1;
          if (count) counts.set(ch, count);
          else counts.delete(ch);
        }
        const length = candidateEnd - start;
        if (length >= 32 && lastPlaceholder < start && shannonEntropy(counts, length) > 3.5) return true;
      }
      if (word === ':' && valueStart === tokens.lastIndex) {
        if (!annotation) annotationDepth = 0;
        annotation ??= assignment;
      } else {
        tokens.lastIndex = valueStart;
        target = '';
        validPrefix = true;
        declaration = false;
        typedDeclaration = false;
        annotation = undefined;
        inValue = true;
        valueStarted = false;
      }
      continue;
    }
    if (
      word === ';' ||
      word === ',' ||
      word === '{' ||
      word === '}' ||
      word === '|' ||
      word === '&' ||
      word === '(' ||
      word === ')'
    ) {
      if (annotation && (word === '|' || word === '&' || word === '(' || word === ')')) continue;
      target = '';
      validPrefix = true;
      declaration = false;
      typedDeclaration = word === ',' && declarationDepths.at(-1) === syntaxDepth;
      annotation = undefined;
      if (word !== '(' && word !== ')') {
        inValue = false;
        valueDepth = 0;
      }
      continue;
    }
    if (annotation) {
      // A URL/path is not a TS type and must not borrow a later '=' value.
      if (!typedDeclaration && !/^[\w$<>&|.,?[\]]+$/.test(word)) annotation.validPrefix = false;
      continue;
    }
    // Whitespace around a member dot does not start a second prose target.
    if (target && (target.endsWith('.') || word.startsWith('.'))) {
      target = word;
      continue;
    }
    if (DECLARATION_MODIFIERS.has(word) || /^set$/i.test(word) || (declaration && /^--?[A-Za-z][\w-]*$/.test(word))) {
      modifierStart.lastIndex = tokens.lastIndex;
      if (modifierStart.test(text)) {
        if (target) validPrefix = false;
        declaration = true;
        typedDeclaration ||= /^(?:const|let|var|declare|readonly|private|protected|public|static)$/.test(word);
        if (validPrefix && /^(?:const|let|var)$/.test(word)) {
          declarationStart.lastIndex = tokens.lastIndex;
          if (declarationStart.test(text)) declarationDepths.push(syntaxDepth);
        }
        continue;
      }
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

function shannonEntropy(freq: Map<string, number>, length: number): number {
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
