import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { resolveActiveProjectRoot } = await import('../dist/utils/active-project-root.js');

describe('resolveActiveProjectRoot', () => {
  const savedEnv = {};

  function setEnv(key, value) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  });

  it('returns CAT_CAFE_CONFIG_ROOT when set to a valid directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cfg-root-'));
    setEnv('CAT_CAFE_CONFIG_ROOT', tmp);
    setEnv('CAT_TEMPLATE_PATH', undefined);
    assert.equal(resolveActiveProjectRoot('/some/random/path'), tmp);
  });

  it('ignores CAT_CAFE_CONFIG_ROOT when it points to a non-existent path', () => {
    setEnv('CAT_CAFE_CONFIG_ROOT', '/nonexistent/path/that/does/not/exist');
    setEnv('CAT_TEMPLATE_PATH', undefined);
    // Should fall through to monorepo root logic (won't be our fake path)
    const result = resolveActiveProjectRoot('/some/random/path');
    assert.notEqual(result, '/nonexistent/path/that/does/not/exist');
  });

  it('ignores CAT_CAFE_CONFIG_ROOT when it points to a file, not a directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cfg-root-'));
    const filePath = join(tmp, 'not-a-dir.txt');
    writeFileSync(filePath, 'hello');
    setEnv('CAT_CAFE_CONFIG_ROOT', filePath);
    setEnv('CAT_TEMPLATE_PATH', undefined);
    const result = resolveActiveProjectRoot('/some/random/path');
    assert.notEqual(result, filePath);
  });

  it('CAT_CAFE_CONFIG_ROOT takes precedence over CAT_TEMPLATE_PATH', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'cfg-root-'));
    const templateDir = mkdtempSync(join(tmpdir(), 'tmpl-'));
    const templateFile = join(templateDir, 'template.yaml');
    writeFileSync(templateFile, 'template: true');
    setEnv('CAT_CAFE_CONFIG_ROOT', configRoot);
    setEnv('CAT_TEMPLATE_PATH', templateFile);
    assert.equal(resolveActiveProjectRoot('/some/random/path'), configRoot);
  });

  it('falls back to monorepo root when CAT_CAFE_CONFIG_ROOT is unset', () => {
    setEnv('CAT_CAFE_CONFIG_ROOT', undefined);
    setEnv('CAT_TEMPLATE_PATH', undefined);
    // Create a tmp dir with pnpm-workspace.yaml to simulate monorepo
    const tmp = mkdtempSync(join(tmpdir(), 'monorepo-'));
    const sub = join(tmp, 'subdir');
    mkdirSync(sub);
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"');
    assert.equal(resolveActiveProjectRoot(sub), tmp);
  });
});
