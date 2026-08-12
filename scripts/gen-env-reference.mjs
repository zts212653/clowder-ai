#!/usr/bin/env node
/**
 * gen:env-reference — Generate docs/env-reference.md from env-registry.ts.
 *
 * Reads ENV_VARS and ENV_CATEGORIES from the registry source through the
 * TypeScript AST (without executing application code) and generates a
 * Markdown reference grouped by category.
 *
 * Run: `node scripts/gen-env-reference.mjs`
 * Wire: `pnpm gen:env-reference` in root package.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCategories, parseVars } from './lib/env-registry-parser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REGISTRY_PATH = join(ROOT, 'packages/api/src/config/env-registry.ts');
const OUTPUT_PATH = join(ROOT, 'docs/env-reference.md');

const src = readFileSync(REGISTRY_PATH, 'utf-8');
const categories = parseCategories(src);
const vars = parseVars(src);

// Group by category
/** @type {Map<string, typeof vars>} */
const grouped = new Map();
for (const v of vars) {
  if (!grouped.has(v.category)) grouped.set(v.category, []);
  grouped.get(v.category).push(v);
}

const lines = [
  '---',
  'feature_ids: []',
  'topics: [env, reference]',
  'doc_kind: reference',
  `created: ${new Date().toISOString().slice(0, 10)}`,
  '---',
  '',
  '# Clowder AI 环境变量参考',
  '',
  `> 自动生成于 ${new Date().toISOString().slice(0, 10)}，真相源：\`packages/api/src/config/env-registry.ts\``,
  '> ',
  '> 运行 \\`pnpm gen:env-reference\\` 重新生成。',
  '',
  `共 ${vars.length} 个变量，${categories.size} 个分类。`,
  '',
];

for (const [catKey, catLabel] of categories) {
  const catVars = grouped.get(catKey);
  if (!catVars || catVars.length === 0) continue;

  lines.push(`## ${catLabel} (\`${catKey}\`)`);
  lines.push('');
  lines.push('| 变量 | 默认值 | 说明 | 敏感 |');
  lines.push('|------|--------|------|------|');
  for (const v of catVars) {
    const def = v.defaultValue.replace(/\|/g, '\\|');
    const desc = v.description.replace(/\|/g, '\\|');
    lines.push(`| \`${v.name}\` | ${def} | ${desc} | ${v.sensitive ? '🔒' : ''} |`);
  }
  lines.push('');
}

const content = lines.join('\n');
writeFileSync(OUTPUT_PATH, content, 'utf-8');
console.log(`✅ Generated ${OUTPUT_PATH} (${vars.length} vars, ${categories.size} categories)`);
