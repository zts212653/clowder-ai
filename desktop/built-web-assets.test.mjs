import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportFrozenRuntime } from './scripts/frozen-runtime-export.mjs';

test('deployment includes generated public CSS, WASM and serviceworker from the actual Web build', () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'built-web-'));
  try {
    const file = (relative, value = 'body { color: red; }') => {
      const target = path.join(own, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
    };
    file('snapshot/pnpm-lock.yaml', 'locked');
    file('snapshot/packages/web/package.json', '{}');
    fs.mkdirSync(path.join(own, 'snapshot/node_modules'));
    file('built/.next/BUILD_ID', 'same-build');
    file('built/.next/cache/webpack/client-production/0.pack', 'compiler-only cache');
    file('built/.next/cache/.tsbuildinfo', 'TypeScript incremental build state');
    file('built/.next/cache/eslint/.cache', 'ESLint build state');
    file('built/.next/cache/fetch-cache/runtime-entry', 'runtime cache witness');
    for (const name of [
      'theme-tokens',
      'cat-persona-tokens',
      'cat-persona-derived',
      'console-shell',
      'console-controls',
      'console-tokens',
      'shell-v2',
      'connector-tokens',
      'theme-extras',
      'werewolf-theme',
    ])
      file(`built/public/vendor/app/${name}.css`);
    file('built/public/vendor/esbuild/esbuild.wasm', 'WASM witness');
    file('built/public/sw.js', 'serviceworker witness');
    const out = path.join(own, 'output');
    exportFrozenRuntime(path.join(own, 'snapshot'), out, ['web'], path.join(own, 'snapshot/pnpm-lock.yaml'), {
      builtWebSource: path.join(own, 'built'),
    });
    assert.equal(
      fs.readFileSync(path.join(out, 'web/public/vendor/app/theme-tokens.css'), 'utf8'),
      'body { color: red; }',
    );
    assert.equal(fs.readFileSync(path.join(out, 'web/public/sw.js'), 'utf8'), 'serviceworker witness');
    assert.equal(fs.readFileSync(path.join(out, 'web/public/vendor/esbuild/esbuild.wasm'), 'utf8'), 'WASM witness');
    assert.equal(fs.readFileSync(path.join(out, 'web/.next/BUILD_ID'), 'utf8'), 'same-build');
    assert.equal(fs.existsSync(path.join(out, 'web/.next/cache/webpack')), false);
    assert.equal(fs.existsSync(path.join(out, 'web/.next/cache/.tsbuildinfo')), false);
    assert.equal(fs.existsSync(path.join(out, 'web/.next/cache/eslint')), false);
    assert.equal(
      fs.readFileSync(path.join(out, 'web/.next/cache/fetch-cache/runtime-entry'), 'utf8'),
      'runtime cache witness',
    );
    fs.renameSync(path.join(own, 'built/public/vendor/app/theme-tokens.css'), path.join(own, 'css-witness'));
    assert.throws(
      () =>
        exportFrozenRuntime(
          path.join(own, 'snapshot'),
          path.join(own, 'missing'),
          ['web'],
          path.join(own, 'snapshot/pnpm-lock.yaml'),
          { builtWebSource: path.join(own, 'built') },
        ),
      /CSS|asset/i,
    );
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});
