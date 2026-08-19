import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const RAW_LEXICAL_PATTERN = /truncate|line-clamp-/g;
const TEXT_TOKEN_PATTERN = /\btruncate\b|\bline-clamp-(?:none|\d+|\[[^\]\s'"`]+\])/g;
const TEST_PATH_PATTERN = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/;
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\/\*|\*)/;
const FIELD_PROP_PATTERN = /\b(?:text|content|value|title|label|description|summary|path|name)=\{([^{}]+)\}/g;

function gitOutput(rootDir, args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function computeAuditSourceFingerprint({ rootDir, ref, sourcePaths }) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('audit source paths are required');
  }
  const manifest = gitOutput(rootDir, ['ls-tree', '-r', '--full-tree', ref, '--', ...sourcePaths]);
  return createHash('sha256').update(manifest).digest('hex');
}

export function assertAuditSourceMatchesBase({
  rootDir,
  auditBaseSha,
  auditSourceFingerprint,
  sourcePaths,
  freshnessRef,
}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('audit source paths are required');
  }
  const runGit = (args) => gitOutput(rootDir, args);
  const objectExists = (object) => {
    try {
      runGit(['cat-file', '-e', object]);
      return true;
    } catch {
      return false;
    }
  };
  const isAncestor = (ancestor, descendant) => {
    try {
      runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if (error?.status === 1) return false;
      throw error;
    }
  };

  const auditBaseExists = objectExists(`${auditBaseSha}^{commit}`);
  if (!auditBaseExists && !/^[0-9a-f]{64}$/.test(auditSourceFingerprint ?? '')) {
    throw new Error(`audit base is not a commit and no source fingerprint is available: ${auditBaseSha}`);
  }

  if (freshnessRef) {
    if (!objectExists(`${freshnessRef}^{commit}`)) {
      throw new Error(`audit freshness ref is not a commit: ${freshnessRef}`);
    }

    const comparisonRef = auditBaseExists ? auditBaseSha : 'HEAD';
    const expectedFingerprint = auditBaseExists
      ? computeAuditSourceFingerprint({ rootDir, ref: auditBaseSha, sourcePaths })
      : auditSourceFingerprint;
    if (auditSourceFingerprint && auditSourceFingerprint !== expectedFingerprint) {
      throw new Error(`audit source fingerprint does not match ${comparisonRef}`);
    }
    const freshnessIsAncestor = isAncestor(freshnessRef, comparisonRef);
    const freshnessMatchesAudit =
      computeAuditSourceFingerprint({ rootDir, ref: freshnessRef, sourcePaths }) === expectedFingerprint;
    const freshnessDrift =
      freshnessIsAncestor || freshnessMatchesAudit
        ? []
        : runGit(['diff', '--name-only', comparisonRef, freshnessRef, '--', ...sourcePaths])
            .split('\n')
            .filter(Boolean)
            .sort();
    if (freshnessDrift.length > 0) {
      throw new Error(`audit source drift on ${freshnessRef} after ${auditBaseSha}: ${freshnessDrift.join(', ')}`);
    }
  }

  const comparisonRef = auditBaseExists ? auditBaseSha : 'HEAD';
  if (!auditBaseExists) {
    const headFingerprint = computeAuditSourceFingerprint({ rootDir, ref: 'HEAD', sourcePaths });
    if (headFingerprint !== auditSourceFingerprint) {
      throw new Error(`audit source fingerprint does not match HEAD after ${auditBaseSha}`);
    }
  }
  const changed = runGit(['diff', '--name-only', comparisonRef, '--', ...sourcePaths])
    .split('\n')
    .filter(Boolean);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '--', ...sourcePaths])
    .split('\n')
    .filter(Boolean);
  const drift = [...new Set([...changed, ...untracked])].sort();
  if (drift.length > 0) {
    throw new Error(`audit source drift after ${auditBaseSha}: ${drift.join(', ')}`);
  }
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function extensionOf(fileName) {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index) : '';
}

function walkSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function isQuotedToken(line, index, token) {
  const before = line.slice(0, index);
  const after = line.slice(index + token.length);
  return ['"', "'", '`'].some((quote) => before.includes(quote) && after.includes(quote));
}

function containsUnescapedQuote(value, quote) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return true;
  }
  return false;
}

function isInsideQuotedClassValue(lines, lineIndex, tokenIndex) {
  const prefix = [...lines.slice(0, lineIndex), lines[lineIndex].slice(0, tokenIndex)].join('\n');
  const openers = [...prefix.matchAll(/\bclassName\s*=\s*(?:\{\s*)?(["'`])/g)];
  const opener = openers.at(-1);
  if (!opener || opener.index === undefined) return false;
  const valueBeforeToken = prefix.slice(opener.index + opener[0].length);
  return !containsUnescapedQuote(valueBeforeToken, opener[1]);
}

function textTokensOnLine(line, relativePath, lines, lineIndex) {
  if (TEST_PATH_PATTERN.test(relativePath) || COMMENT_LINE_PATTERN.test(line)) return [];
  const tokens = [];
  for (const match of line.matchAll(TEXT_TOKEN_PATTERN)) {
    if (
      match.index !== undefined &&
      (isQuotedToken(line, match.index, match[0]) || isInsideQuotedClassValue(lines, lineIndex, match.index))
    ) {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

function excerpt(line) {
  const trimmed = line.trim();
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function cleanFieldExpression(value) {
  const trimmed = value.trim();
  const interpolation = trimmed.match(/\$\{([^{}]+)\}/);
  return (interpolation?.[1] ?? trimmed).trim();
}

function semanticFieldOnLine(line) {
  for (const match of line.matchAll(FIELD_PROP_PATTERN)) {
    const value = cleanFieldExpression(match[1]);
    if (value) return value;
  }
  const trimmed = line.trim();
  const standalone = trimmed.match(/^\{([^{}]+)\}$/);
  if (standalone) return cleanFieldExpression(standalone[1]);
  const inlineChild = line.match(/>[^<]*\{([^{}]+)\}[^<]*<\//);
  if (inlineChild) return cleanFieldExpression(inlineChild[1]);
  return undefined;
}

function inferFieldHint(lines, index) {
  for (let distance = 0; distance <= 4; distance += 1) {
    const indexes = distance === 0 ? [index] : [index + distance, index - distance];
    for (const candidateIndex of indexes) {
      if (candidateIndex < 0 || candidateIndex >= lines.length) continue;
      const field = semanticFieldOnLine(lines[candidateIndex]);
      if (field) return field;
    }
  }
  return undefined;
}

export function scanCssLexical({ rootDir, sourceDir = 'packages/web/src' }) {
  const absoluteSourceDir = join(rootDir, sourceDir);
  const records = [];
  const rawFiles = new Set();
  const textTokenFiles = new Set();
  let rawLexicalMatches = 0;
  let textTokenMatches = 0;

  for (const filePath of walkSourceFiles(absoluteSourceDir)) {
    const relativePath = toPosix(relative(rootDir, filePath));
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const rawTokens = [...line.matchAll(RAW_LEXICAL_PATTERN)].map((match) => match[0]);
      if (rawTokens.length === 0) continue;

      const textTokens = textTokensOnLine(line, relativePath, lines, index);
      rawFiles.add(relativePath);
      rawLexicalMatches += rawTokens.length;
      if (textTokens.length > 0) {
        textTokenFiles.add(relativePath);
        textTokenMatches += textTokens.length;
      }

      const lineNumber = index + 1;
      records.push({
        id: `css:${relativePath}:${lineNumber}`,
        sourceKind: 'css-lexical',
        candidateKind: textTokens.length > 0 ? 'text-token' : 'lexical-noise',
        path: relativePath,
        line: lineNumber,
        sourceToken: (textTokens.length > 0 ? textTokens : rawTokens).join(' + '),
        sourceExcerpt: excerpt(line),
        lexicalMatchCount: rawTokens.length,
        textTokenMatchCount: textTokens.length,
        textTokens,
        fieldHint: inferFieldHint(lines, index),
      });
    }
  }

  return {
    sourceDir: toPosix(sourceDir),
    rawLexicalFiles: rawFiles.size,
    rawLexicalMatches,
    textTokenFiles: textTokenFiles.size,
    textTokenMatches,
    records,
  };
}

function assertUniqueLocator(locator, seenIds) {
  if (!locator.id || seenIds.has(locator.id)) throw new Error(`duplicate producer locator id: ${locator.id}`);
  seenIds.add(locator.id);
  if (!Array.isArray(locator.needles) || locator.needles.length === 0) {
    throw new Error(`producer locator ${locator.id} must declare needles`);
  }
}

function findUniqueNeedleLine(lines, locator, needle) {
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) matches.push(index + 1);
  }
  if (matches.length !== 1) {
    throw new Error(
      `producer locator ${locator.id} needle ${JSON.stringify(needle)} expected exactly one match, found ${matches.length}`,
    );
  }
  return matches[0];
}

function scanPhysicalProducer(rootDir, locator) {
  const lines = readFileSync(join(rootDir, locator.path), 'utf8').split('\n');
  const uniqueLines = [...new Set(locator.needles.map((needle) => findUniqueNeedleLine(lines, locator, needle)))].sort(
    (a, b) => a - b,
  );
  return {
    id: locator.id,
    sourceKind: 'physical-producer',
    candidateKind: 'physical-producer',
    path: toPosix(locator.path),
    line: uniqueLines[0],
    sourceToken: locator.sourceToken ?? '.slice()',
    sourceExcerpt: uniqueLines.map((line) => excerpt(lines[line - 1])).join(' | '),
    lexicalMatchCount: 0,
    textTokenMatchCount: 0,
    textTokens: [],
    locatorLines: uniqueLines,
  };
}

export function scanPhysicalProducers({ rootDir, locators }) {
  const seenIds = new Set();
  return locators.map((locator) => {
    assertUniqueLocator(locator, seenIds);
    return scanPhysicalProducer(rootDir, locator);
  });
}
