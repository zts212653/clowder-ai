#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HELP = `Usage: node scripts/check-frontmatter.mjs [--docs-root docs] [--json]

Scan markdown files and report frontmatter coverage.
`;

const REQUIRED_FIELDS = ['doc_kind', 'created'];
const FRONTMATTER_RE = /^\uFEFF?---\n([\s\S]*?)\n---\n/;

function parseArgs(argv) {
  const out = {
    docsRoot: path.resolve(process.cwd(), 'docs'),
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (arg === '--docs-root') {
      out.docsRoot = path.resolve(process.cwd(), argv[++i] ?? 'docs');
      continue;
    }
    if (arg === '--json') {
      out.json = true;
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

function run() {
  const args = parseArgs(process.argv.slice(2));
  const files = walkMarkdownFiles(args.docsRoot);

  const missingFrontmatter = [];
  const missingRequiredByField = {
    doc_kind: [],
    created: [],
  };

  for (const filePath of files) {
    const relative = path.relative(args.docsRoot, filePath);
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

  const withFrontmatter = files.length - missingFrontmatter.length;
  const result = {
    totalMarkdownFiles: files.length,
    withFrontmatter,
    missingFrontmatterCount: missingFrontmatter.length,
    missingFrontmatter,
    missingRequired: {
      doc_kind: missingRequiredByField.doc_kind,
      created: missingRequiredByField.created,
    },
  };

  if (args.json) {
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

run();
