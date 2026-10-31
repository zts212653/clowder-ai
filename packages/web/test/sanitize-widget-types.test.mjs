import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

test('widget sanitizer typechecks with distinct nominal Trusted Types declarations', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'widget-trusted-types-'));
  try {
    const purifierRequire = createRequire(require.resolve('dompurify'));
    copyFileSync(
      purifierRequire.resolve('@types/trusted-types/lib/index.d.ts'),
      path.join(fixture, 'trusted-types-copy.d.ts'),
    );
    const ambient = path.join(fixture, 'window.d.ts');
    writeFileSync(
      ambient,
      [
        "import type { TrustedTypesWindow } from './trusted-types-copy';",
        'declare global { interface Window extends TrustedTypesWindow {} }',
        'export {};',
      ].join('\n'),
    );
    const program = ts.createProgram([ambient, path.join(webRoot, 'src/components/rich/sanitize-widget-html.ts')], {
      noEmit: true,
      strict: true,
      types: ['node'],
      lib: ['lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.es2022.d.ts'],
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => webRoot,
        getNewLine: () => '\n',
      }),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
