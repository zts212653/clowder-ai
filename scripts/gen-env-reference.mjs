#!/usr/bin/env node
/**
 * gen:env-reference — Generate docs/env-reference.md from env-registry.ts.
 *
 * Reads ENV_VARS and ENV_CATEGORIES from the registry source (regex parse,
 * no import needed) and generates a Markdown reference grouped by category.
 *
 * Run: `node scripts/gen-env-reference.mjs`
 * Wire: `pnpm gen:env-reference` in root package.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REGISTRY_PATH = join(ROOT, 'packages/api/src/config/env-registry.ts');
const OUTPUT_PATH = join(ROOT, 'docs/env-reference.md');

// ── Parse ENV_CATEGORIES ──
function parseCategories(src) {
  /** @type {Map<string, string>} */
  const cats = new Map();
  const block = src.match(/ENV_CATEGORIES[^{]*\{([^}]+)\}/s);
  if (!block) return cats;
  for (const m of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) {
    cats.set(m[1], m[2]);
  }
  return cats;
}

// ── Parse ENV_VARS ──
function parseVars(src) {
  /** @type {Array<{name:string, category:string, defaultValue:string, description:string, sensitive:boolean}>} */
  const vars = [];
  const objPattern = /\{([^}]+)\}/gs;
  for (const block of src.matchAll(objPattern)) {
    const body = block[1];
    const nameMatch = body.match(/name:\s*['"]([A-Z_][A-Z0-9_]*)['"]/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const catMatch = body.match(/category:\s*['"](\w+)['"]/);
    const defMatch = body.match(/defaultValue:\s*['"](.+?)['"]/);
    const descMatch = body.match(/description:\s*\n?\s*['"](.+?)['"]/s);
    const sensitive = /sensitive:\s*true/.test(body);

    vars.push({
      name,
      category: catMatch?.[1] ?? 'unknown',
      defaultValue: defMatch?.[1] ?? '—',
      description: descMatch?.[1]?.replace(/\n\s*/g, ' ') ?? '',
      sensitive,
    });
  }
  return vars;
}

// ── Generate Markdown ──
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
  '# Cat Cafe 环境变量参考',
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
