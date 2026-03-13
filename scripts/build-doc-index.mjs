#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * build-doc-index.mjs — Scan docs/ for YAML frontmatter, build a relation index.
 *
 * Output: docs/.doc-index.json
 *   { files: [{ path, title, summary, frontmatter, edges, backlinks }] }
 *
 * Usage:
 *   node scripts/build-doc-index.mjs          # build index
 *   node scripts/build-doc-index.mjs --check  # check consistency (CI mode)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS_DIR = resolve(ROOT, 'docs');
const OUTPUT = resolve(DOCS_DIR, '.doc-index.json');
const CHECK_MODE = process.argv.includes('--check');

/** Recursively find all .md files */
function findMarkdown(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip archive, node_modules, .git
      if (['archive', 'node_modules', '.git'].includes(entry.name)) continue;
      results.push(...findMarkdown(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/** Extract YAML frontmatter from markdown */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  let currentKey = null;
  let blockArray = null;
  for (const line of match[1].split('\n')) {
    // Block-style array item: "  - value"
    const listItem = line.match(/^\s+-\s+(.+)/);
    if (listItem && currentKey) {
      if (!blockArray) blockArray = [];
      blockArray.push(listItem[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    // Flush any pending block array
    if (currentKey && blockArray) {
      fm[currentKey] = blockArray;
      currentKey = null;
      blockArray = null;
    }
    // Key with no inline value → start of block-style array (e.g. "topics:")
    const bareKey = line.match(/^(\w[\w_]*)\s*:\s*$/);
    if (bareKey) {
      currentKey = bareKey[1];
      blockArray = [];
      continue;
    }
    const kv = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
    if (!kv) continue;
    currentKey = null;
    blockArray = null;
    const [, key, rawVal] = kv;
    // Parse arrays: [a, b, c] or []
    if (rawVal.trim() === '[]') {
      fm[key] = [];
    } else {
      const arrayMatch = rawVal.match(/^\[(.+)\]$/);
      if (arrayMatch) {
        fm[key] = arrayMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      } else {
        fm[key] = rawVal.trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  // Flush trailing block array
  if (currentKey && blockArray) {
    fm[currentKey] = blockArray;
  }
  return fm;
}

/** Extract H1 title from markdown */
function extractTitle(content) {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

/** Extract first non-heading paragraph as summary */
function extractSummary(content) {
  // Skip frontmatter
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  // Find first non-empty, non-heading line
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('|') && !trimmed.startsWith('```')) {
      return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
    }
  }
  return null;
}

/** Build edges from frontmatter fields */
function buildEdges(fm) {
  const edges = [];
  if (fm.feature_ids) {
    for (const fid of Array.isArray(fm.feature_ids) ? fm.feature_ids : [fm.feature_ids]) {
      edges.push({ type: 'feature', target: fid });
    }
  }
  if (fm.related_features) {
    for (const fid of Array.isArray(fm.related_features) ? fm.related_features : [fm.related_features]) {
      edges.push({ type: 'related', target: fid });
    }
  }
  if (fm.related_decisions) {
    for (const did of Array.isArray(fm.related_decisions) ? fm.related_decisions : [fm.related_decisions]) {
      edges.push({ type: 'decision', target: `ADR-${did}` });
    }
  }
  return edges;
}

// --- Main ---

const mdFiles = findMarkdown(DOCS_DIR);
const index = { generatedAt: new Date().toISOString(), files: [] };
const errors = [];

for (const filepath of mdFiles) {
  const relPath = relative(ROOT, filepath);
  // Normalize CRLF → LF once for all parsers (cross-platform)
  const content = readFileSync(filepath, 'utf-8').replace(/\r\n/g, '\n');
  const fm = parseFrontmatter(content);
  const title = extractTitle(content);
  const summary = extractSummary(content);

  if (!fm) {
    if (!relPath.includes('archive/')) {
      errors.push(`${relPath}: missing frontmatter`);
    }
    continue;
  }

  if (!fm.doc_kind) {
    errors.push(`${relPath}: missing doc_kind in frontmatter`);
  }

  const edges = buildEdges(fm);

  index.files.push({
    path: relPath,
    title,
    summary,
    frontmatter: {
      doc_kind: fm.doc_kind || null,
      feature_ids: fm.feature_ids || [],
      topics: fm.topics || [],
      created: fm.created || null,
    },
    edges,
  });
}

// Build backlinks (reverse edges)
const featureToFiles = new Map();
for (const file of index.files) {
  for (const edge of file.edges) {
    if (edge.type === 'feature') {
      if (!featureToFiles.has(edge.target)) featureToFiles.set(edge.target, []);
      featureToFiles.get(edge.target).push(file.path);
    }
  }
}

for (const file of index.files) {
  const backlinks = [];
  for (const edge of file.edges) {
    if (edge.type === 'related') {
      const sources = featureToFiles.get(edge.target) || [];
      for (const src of sources) {
        if (src !== file.path) backlinks.push(src);
      }
    }
  }
  file.backlinks = [...new Set(backlinks)];
}

if (CHECK_MODE) {
  // P2 fix: warnings (missing frontmatter) are non-fatal in check mode —
  // many legacy docs lack frontmatter, so this can't gate CI yet.
  if (errors.length > 0) {
    console.warn(`Doc index check: ${errors.length} warning(s) (non-fatal):`);
    for (const e of errors) console.warn(`  - ${e}`);
  }
  // P2 fix: compare content hash, not just file count — detects stale metadata.
  // If index absent (fresh checkout / CI), generate it so the gate is usable standalone.
  if (!existsSync(OUTPUT)) {
    writeFileSync(OUTPUT, `${JSON.stringify(index, null, 2)}\n`);
    console.log(`Doc index generated (first run): ${index.files.length} files, ${errors.length} issues. OK.`);
    process.exit(0);
  }
  const existing = JSON.parse(readFileSync(OUTPUT, 'utf-8'));
  const existingHash = createHash('sha256').update(JSON.stringify(existing.files)).digest('hex');
  const freshHash = createHash('sha256').update(JSON.stringify(index.files)).digest('hex');
  if (existingHash !== freshHash) {
    console.error(`Doc index stale: content hash mismatch. Run 'node scripts/build-doc-index.mjs' to regenerate.`);
    process.exit(1);
  }
  console.log(`Doc index check: ${index.files.length} files, ${errors.length} issues. OK.`);
  process.exit(0);
}

// Write mode
writeFileSync(OUTPUT, `${JSON.stringify(index, null, 2)}\n`);
console.log(`Doc index built: ${index.files.length} files → ${relative(ROOT, OUTPUT)}`);
if (errors.length > 0) {
  console.warn(`Warnings: ${errors.length} issue(s):`);
  for (const e of errors) console.warn(`  - ${e}`);
}
