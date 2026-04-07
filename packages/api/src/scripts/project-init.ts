/**
 * F102 Phase F-1: project-init CLI
 * Scaffolds standard docs/ directory structure for a new project,
 * enabling IndexBuilder to index documents immediately.
 *
 * Usage: pnpm --filter @cat-cafe/api project:init [target-dir]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_DIRS } from '../domains/memory/IndexBuilder.js';

export interface InitResult {
  created: string[];
  skipped: string[];
}

const SKELETON_FILES: Record<string, string> = {
  'BACKLOG.md': `---
doc_kind: plan
created: {DATE}
---

# Backlog

| ID | Feature | Status | Owner | Source | Ref |
|----|---------|--------|-------|--------|-----|
`,
  'VISION.md': `---
doc_kind: plan
created: {DATE}
---

# Vision

> What is this project trying to achieve?
`,
};

export async function runProjectInit(targetDir: string): Promise<InitResult> {
  const docsDir = join(targetDir, 'docs');
  const created: string[] = [];
  const skipped: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // Create all KIND_DIRS subdirectories
  for (const dir of Object.keys(KIND_DIRS)) {
    const dirPath = join(docsDir, dir);
    mkdirSync(dirPath, { recursive: true });
    created.push(`${dir}/`);
  }

  // Create skeleton files (skip if exists — idempotent)
  for (const [filename, template] of Object.entries(SKELETON_FILES)) {
    const filePath = join(docsDir, filename);
    if (existsSync(filePath)) {
      skipped.push(filename);
    } else {
      writeFileSync(filePath, template.replace(/{DATE}/g, today));
      created.push(filename);
    }
  }

  return { created, skipped };
}

// Direct invocation
const entryPath = process.argv[1];
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  const targetDir = process.argv[2] ?? process.cwd();
  console.log(`[project-init] Initializing docs structure in: ${targetDir}`);
  runProjectInit(targetDir)
    .then((result) => {
      console.log(`[project-init] Created: ${result.created.length} items`);
      console.log(`[project-init] Skipped: ${result.skipped.length} items`);
      if (result.skipped.length > 0) {
        console.log(`[project-init] Skipped files (already exist): ${result.skipped.join(', ')}`);
      }
    })
    .catch((err) => {
      console.error('[project-init] Error:', err);
      process.exitCode = 1;
    });
}
