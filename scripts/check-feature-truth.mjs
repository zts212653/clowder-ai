#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : defaultRepoRoot;

const backlogPath = join(repoRoot, 'docs', 'BACKLOG.md');
const roadmapPath = join(repoRoot, 'docs', 'ROADMAP.md');
const currentIndexPath = join(repoRoot, 'docs', 'features', 'index.json');
const generatorPath = join(repoRoot, 'scripts', 'generate-feature-index.mjs');

function isDoneStatus(status) {
  return /^\s*done\b/i.test(String(status ?? ''));
}

function parseBacklogFeatureIds(markdown) {
  const ids = new Set();
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\|\s*(F\d{3,4})\s*\|/);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function loadJson(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

function resolveTruthDocPath() {
  if (existsSync(backlogPath)) {
    return { path: backlogPath, label: 'BACKLOG' };
  }

  if (existsSync(roadmapPath)) {
    return { path: roadmapPath, label: 'ROADMAP' };
  }

  throw new Error(`Missing backlog/roadmap: ${backlogPath} | ${roadmapPath}`);
}

function buildFeatureStatusMap(features) {
  const map = new Map();

  for (const feature of features) {
    const id = feature?.id;
    if (typeof id !== 'string' || !/^F\d{3,4}$/.test(id)) {
      continue;
    }

    const status = String(feature?.status ?? '');
    const entry = map.get(id) ?? { hasActive: false, hasDone: false };
    if (isDoneStatus(status)) {
      entry.hasDone = true;
    } else {
      entry.hasActive = true;
    }
    map.set(id, entry);
  }

  return map;
}

function generateFreshIndex(outputPath) {
  if (!existsSync(generatorPath)) {
    throw new Error(`Missing generator script: ${generatorPath}`);
  }

  execFileSync('node', [generatorPath, '--output', outputPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

function deepEqualFeatures(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  const errors = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'cc-feature-truth-'));
  const generatedIndexPath = join(tempDir, 'index.json');

  try {
    if (!existsSync(currentIndexPath)) {
      throw new Error(`Missing feature index: ${currentIndexPath}`);
    }

    generateFreshIndex(generatedIndexPath);

    const truthDoc = resolveTruthDocPath();
    const backlogMarkdown = readFileSync(truthDoc.path, 'utf-8');
    const currentIndex = loadJson(currentIndexPath);
    const generatedIndex = loadJson(generatedIndexPath);

    const currentFeatures = Array.isArray(currentIndex.features) ? currentIndex.features : [];
    const generatedFeatures = Array.isArray(generatedIndex.features) ? generatedIndex.features : [];

    if (!deepEqualFeatures(currentFeatures, generatedFeatures)) {
      errors.push('[index-sync] docs/features/index.json is stale. Run: node scripts/generate-feature-index.mjs');
    }

    const backlogIds = parseBacklogFeatureIds(backlogMarkdown);
    const statusMap = buildFeatureStatusMap(generatedFeatures);

    for (const backlogId of backlogIds) {
      const entry = statusMap.get(backlogId);
      if (!entry) {
        errors.push(`[backlog-ref] ${truthDoc.label} contains ${backlogId}, but no such feature exists in index`);
        continue;
      }
      if (!entry.hasActive && entry.hasDone) {
        errors.push(`[backlog-active] ${truthDoc.label} contains ${backlogId}, but all records are done`);
      }
    }

    for (const [featureId, entry] of statusMap.entries()) {
      if (entry.hasActive && !backlogIds.has(featureId)) {
        errors.push(`[backlog-missing] Active feature ${featureId} is missing from ${truthDoc.label}`);
      }
    }

    if (errors.length > 0) {
      console.error(`FAIL check-feature-truth: ${errors.length} issue(s) found`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }

    console.log(
      `PASS check-feature-truth: features=${generatedFeatures.length} ${truthDoc.label.toLowerCase()}_active=${backlogIds.size}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL check-feature-truth: ${message}`);
  process.exit(1);
}
