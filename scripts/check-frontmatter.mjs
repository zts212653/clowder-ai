#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HELP = `Usage: node scripts/check-frontmatter.mjs [--docs-root docs] [--json]
       node scripts/check-frontmatter.mjs --strict-delta [--base origin/main] [--docs-root docs]

Scan markdown files and report frontmatter coverage.

--strict-delta validates only changed markdown documents. New documents must
have doc_kind and created. Existing legacy debt is allowed, but a change may
not corrupt frontmatter or remove a required field that was already present.
`;

const REQUIRED_FIELDS = ['doc_kind', 'created'];
const FRONTMATTER_RE = /^\uFEFF?---\n([\s\S]*?)\n---\n/;

function requiredArg(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const out = {
    base: 'origin/main',
    docsRoot: path.resolve(process.cwd(), 'docs'),
    json: false,
    strictDelta: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (arg === '--docs-root') {
      out.docsRoot = path.resolve(process.cwd(), requiredArg(argv, ++i, arg));
      continue;
    }
    if (arg === '--base') {
      out.base = requiredArg(argv, ++i, arg);
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--strict-delta') {
      out.strictDelta = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return out;
}

function hasFrontmatter(content) {
  return FRONTMATTER_RE.test(content);
}

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return {};

  const parsed = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.+)?$/i);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = (kv[2] ?? '').trim();
    parsed[key] = value;
  }
  return parsed;
}

function isMissingValue(value) {
  return value === undefined || String(value).trim() === '';
}

function inspectFrontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    return { state: 'missing', metadata: {} };
  }

  const closingDelimiter = normalized.indexOf('\n---\n', 4);
  if (closingDelimiter === -1) {
    return { state: 'malformed', metadata: {} };
  }

  const block = normalized.slice(4, closingDelimiter);
  return {
    state: 'valid',
    metadata: parseFrontmatter(`---\n${block}\n---\n`),
  };
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectChangedMarkdownFiles({ base, docsRoot }) {
  const committed = gitOutput(['diff', '--name-only', `${base}...HEAD`]);
  const unstaged = gitOutput(['diff', '--name-only']);
  const staged = gitOutput(['diff', '--name-only', '--cached']);
  const untracked = gitOutput(['ls-files', '--others', '--exclude-standard']);
  const paths = new Set(`${committed}\n${unstaged}\n${staged}\n${untracked}`.split(/\r?\n/).filter(Boolean));

  return [...paths]
    .map((relativePath) => path.resolve(process.cwd(), relativePath))
    .filter((absolutePath) => {
      const relativeToDocs = path.relative(docsRoot, absolutePath);
      return (
        relativeToDocs !== '' &&
        !relativeToDocs.startsWith(`..${path.sep}`) &&
        relativeToDocs !== '..' &&
        !path.isAbsolute(relativeToDocs) &&
        absolutePath.endsWith('.md') &&
        fs.existsSync(absolutePath)
      );
    })
    .sort();
}

function readBaseFile(base, filePath) {
  const relativePath = path.relative(process.cwd(), filePath).split(path.sep).join('/');
  try {
    return gitOutput(['show', `${base}:${relativePath}`]);
  } catch {
    return null;
  }
}

function validateNewFrontmatter(relative, current) {
  if (current.state === 'missing') return [`${relative}: missing frontmatter`];
  if (current.state === 'malformed') return [`${relative}: malformed frontmatter`];
  return REQUIRED_FIELDS.filter((field) => isMissingValue(current.metadata[field])).map(
    (field) => `${relative}: missing required field ${field}`,
  );
}

function validateExistingFrontmatter(relative, before, current) {
  if (before.state === 'malformed') return [];
  if (before.state === 'missing') {
    return current.state === 'malformed' ? [`${relative}: malformed frontmatter`] : [];
  }
  if (current.state !== 'valid') return [`${relative}: malformed frontmatter`];

  return REQUIRED_FIELDS.filter(
    (field) => !isMissingValue(before.metadata[field]) && isMissingValue(current.metadata[field]),
  ).map((field) => `${relative}: removed required field ${field}`);
}

function validateChangedFile({ base, docsRoot, filePath }) {
  const relative = path.relative(docsRoot, filePath).split(path.sep).join('/');
  const current = inspectFrontmatter(fs.readFileSync(filePath, 'utf8'));
  const baseContent = readBaseFile(base, filePath);
  if (baseContent === null) return validateNewFrontmatter(relative, current);
  return validateExistingFrontmatter(relative, inspectFrontmatter(baseContent), current);
}

function validateStrictDelta({ base, docsRoot }) {
  const canonicalDocsRoot = fs.realpathSync(docsRoot);
  const files = collectChangedMarkdownFiles({ base, docsRoot: canonicalDocsRoot });
  const errors = files.flatMap((filePath) => validateChangedFile({ base, docsRoot: canonicalDocsRoot, filePath }));

  if (errors.length > 0) {
    for (const error of errors) console.error(`FAIL check-frontmatter-delta: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS check-frontmatter-delta: changed=${files.length}`);
}

function walkMarkdownFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }
  files.sort();
  return files;
}

function collectAuditResult(docsRoot) {
  const files = walkMarkdownFiles(docsRoot);
  const missingFrontmatter = [];
  const missingRequiredByField = {
    doc_kind: [],
    created: [],
  };

  for (const filePath of files) {
    const relative = path.relative(docsRoot, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    if (!hasFrontmatter(content)) {
      missingFrontmatter.push(relative);
      continue;
    }

    const metadata = parseFrontmatter(content);
    for (const field of REQUIRED_FIELDS) {
      if (isMissingValue(metadata[field])) {
        missingRequiredByField[field].push(relative);
      }
    }
  }

  return {
    totalMarkdownFiles: files.length,
    withFrontmatter: files.length - missingFrontmatter.length,
    missingFrontmatterCount: missingFrontmatter.length,
    missingFrontmatter,
    missingRequired: {
      doc_kind: missingRequiredByField.doc_kind,
      created: missingRequiredByField.created,
    },
  };
}

function printAuditResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('[check-frontmatter] scan complete');
  console.log(`[check-frontmatter] total=${result.totalMarkdownFiles}`);
  console.log(`[check-frontmatter] with_frontmatter=${result.withFrontmatter}`);
  console.log(`[check-frontmatter] missing_frontmatter=${result.missingFrontmatterCount}`);
  console.log(`[check-frontmatter] missing_doc_kind=${result.missingRequired.doc_kind.length}`);
  console.log(`[check-frontmatter] missing_created=${result.missingRequired.created.length}`);

  if (result.missingFrontmatter.length > 0) {
    console.log('\n[check-frontmatter] missing frontmatter files:');
    for (const item of result.missingFrontmatter) {
      console.log(`- ${item}`);
    }
  }

  if (result.missingRequired.doc_kind.length > 0) {
    console.log('\n[check-frontmatter] files missing doc_kind:');
    for (const item of result.missingRequired.doc_kind) {
      console.log(`- ${item}`);
    }
  }

  if (result.missingRequired.created.length > 0) {
    console.log('\n[check-frontmatter] files missing created:');
    for (const item of result.missingRequired.created) {
      console.log(`- ${item}`);
    }
  }
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.strictDelta) {
    validateStrictDelta(args);
    return;
  }
  printAuditResult(collectAuditResult(args.docsRoot), args.json);
}

run();
