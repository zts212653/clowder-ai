import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readResolvedTemplateSource } from '../dist/config/cat-config-loader.js';

function writeTemplate(path, roleTemplates) {
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      roleTemplates,
      clientDefaults: {},
      breeds: [],
      roster: { owner: { name: 'owner' } },
    }),
  );
}

test('merges shipped role templates into an older project template', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-template-overlay-'));
  const base = join(root, 'shipped.json');
  const project = join(root, 'project.json');
  const previousBase = process.env.CAT_TEMPLATE_BASE_PATH;
  try {
    writeTemplate(base, [
      { id: 'turkish-van', name: '梵花猫' },
      { id: 'dsh', name: '小鲸鱼' },
    ]);
    writeTemplate(project, [
      { id: 'turkish-van', name: '用户自定义梵花' },
      { id: 'legacy-only', name: '旧模板' },
    ]);
    process.env.CAT_TEMPLATE_BASE_PATH = base;
    const merged = JSON.parse(readResolvedTemplateSource(project));
    const byId = Object.fromEntries(merged.roleTemplates.map((template) => [template.id, template.name]));
    assert.equal(byId['turkish-van'], '用户自定义梵花', 'project overlay must win');
    assert.equal(byId['legacy-only'], '旧模板', 'project-only template must remain');
    assert.equal(byId.dsh, '小鲸鱼', 'shipped-only template must be appended');
  } finally {
    if (previousBase === undefined) delete process.env.CAT_TEMPLATE_BASE_PATH;
    else process.env.CAT_TEMPLATE_BASE_PATH = previousBase;
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps the project template when no shipped base is configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-template-overlay-'));
  const project = join(root, 'project.json');
  const previousBase = process.env.CAT_TEMPLATE_BASE_PATH;
  try {
    writeTemplate(project, [{ id: 'legacy-only', name: '旧模板' }]);
    delete process.env.CAT_TEMPLATE_BASE_PATH;
    const merged = JSON.parse(readResolvedTemplateSource(project));
    assert.deepEqual(
      merged.roleTemplates.map((template) => template.id),
      ['legacy-only'],
    );
  } finally {
    if (previousBase === undefined) delete process.env.CAT_TEMPLATE_BASE_PATH;
    else process.env.CAT_TEMPLATE_BASE_PATH = previousBase;
    rmSync(root, { recursive: true, force: true });
  }
});
