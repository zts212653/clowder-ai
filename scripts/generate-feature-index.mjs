#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HELP = `Usage: node scripts/generate-feature-index.mjs [--features-dir docs/features] [--output docs/features/index.json]

Generate a lightweight machine index for feature docs.
`;

function parseArgs(argv) {
  const out = {
    featuresDir: path.resolve(process.cwd(), 'docs', 'features'),
    outputPath: path.resolve(process.cwd(), 'docs', 'features', 'index.json'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (arg === '--features-dir') {
      out.featuresDir = path.resolve(process.cwd(), argv[++i] ?? 'docs/features');
      continue;
    }
    if (arg === '--output' || arg === '--out') {
      out.outputPath = path.resolve(process.cwd(), argv[++i] ?? 'docs/features/index.json');
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return out;
}

const FRONTMATTER_RE = /^\uFEFF?---\n([\s\S]*?)\n---\n/;

function normalizeFeatureId(raw) {
  const match = raw.match(/f?(\d{1,4})/i);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  if (!Number.isFinite(num) || num <= 0) return null;
  return `F${String(num).padStart(3, '0')}`;
}

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

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

function parseFeatureIdsFromFrontmatter(fm) {
  const raw = fm?.feature_ids;
  if (!raw) return [];
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    const normalized = normalizeFeatureId(raw);
    return normalized ? [normalized] : [];
  }
  const normalized = raw
    .slice(1, -1)
    .split(',')
    .map((item) => normalizeFeatureId(item))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function parseStatus(content) {
  const headerMatch = content.match(/^\uFEFF?---\n[\s\S]*?\n---\n/);
  const body = headerMatch ? content.slice(headerMatch[0].length) : content;
  const firstLines = body.split('\n').slice(0, 30).join('\n');
  const statusMatch = firstLines.match(/>\s*\*\*Status\*\*:\s*([^\n<>]+)/i);
  if (statusMatch) return statusMatch[1].trim();
  return 'unknown';
}

function parseTitle(content) {
  const body = content.replace(FRONTMATTER_RE, '');
  const heading = body.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : '';
}

function stripFeaturePrefix(id, title) {
  const match = title.match(/^F0*(\d{1,4})(?::?\s+|\s+-\s+)(.+)$/i);
  if (!match) return title;
  const normalizedInTitle = normalizeFeatureId(match[1]);
  const normalizedId = normalizeFeatureId(id);
  if (normalizedInTitle && normalizedId && normalizedInTitle === normalizedId) {
    return match[2].trim();
  }
  return title;
}

function listFeatureFiles(featuresDir) {
  if (!fs.existsSync(featuresDir)) {
    throw new Error(`Feature directory not found: ${featuresDir}`);
  }

  return fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^F\d+/i.test(path.basename(name, '.md')) && name.endsWith('.md'))
    .filter((name) => name !== 'index.json')
    .map((name) => path.join(featuresDir, name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function inferFeatureRecord(filePath) {
  const filename = path.basename(filePath);
  const stem = path.basename(filename, '.md');

  const content = fs.readFileSync(filePath, 'utf8');
  const frontmatter = parseFrontmatter(content) ?? {};
  const featureIds = parseFeatureIdsFromFrontmatter(frontmatter);

  const fileId = normalizeFeatureId(stem);
  const inferredId = featureIds.find(Boolean) ?? fileId;
  if (!inferredId) {
    throw new Error(`Cannot infer feature id for ${filename}`);
  }

  const headingTitle = parseTitle(content);
  const title = headingTitle || filename.replace(/\.md$/i, '');
  const status = parseStatus(content);

  let name = title;
  name = stripFeaturePrefix(inferredId, name);
  if (!name) name = filename;

  return {
    id: inferredId,
    name,
    status,
    file: filename,
  };
}

function sortByFeatureId(a, b) {
  const aNum = Number.parseInt(a.id.slice(1), 10);
  const bNum = Number.parseInt(b.id.slice(1), 10);
  return aNum - bNum;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const featureFiles = listFeatureFiles(args.featuresDir);
  const records = featureFiles.map(inferFeatureRecord).sort(sortByFeatureId);

  const index = {
    features: records,
    generated_at: new Date().toISOString(),
  };

  const output = `${JSON.stringify(index, null, 2)}\n`;
  fs.writeFileSync(args.outputPath, output, 'utf8');
  console.log(`[generate-feature-index] scanned=${records.length}`);
  console.log(`[generate-feature-index] output=${path.relative(process.cwd(), args.outputPath)}`);
}

runCli();
