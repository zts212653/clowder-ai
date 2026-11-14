import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import pino from 'pino';
import ts from 'typescript';

test('the production watcher report hooks preserve Error messages and stacks through pino', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const callbacks = [];
  const walk = (node) => {
    if (
      ts.isArrowFunction(node) &&
      ts.isCallExpression(node.body) &&
      node.body.expression.getText(source) === 'app.log.warn' &&
      node.body.arguments[1]?.text?.startsWith('Watcher ')
    )
      callbacks.push(node.getText(source));
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.equal(callbacks.length, 3, 'exercise the always-on startup, invocation and receipt hooks');
  for (const callback of callbacks) {
    const rows = [];
    const log = pino({ level: 'warn' }, { write: (line) => rows.push(JSON.parse(line)) });
    const report = vm.runInNewContext(
      ts.transpileModule(`const report=${callback}; report;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      { app: { log }, message: { id: 'control-message' } },
    );
    report(new Error('provider configuration rejected'), 'watcher-line');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].err?.message, 'provider configuration rejected', rows[0].msg);
    assert.match(rows[0].err.stack, /watcher-diagnostics.test.js/);
    if (rows[0].threadId !== undefined) assert.equal(rows[0].threadId, 'watcher-line');
  }
});

test('production always constructs the supervisor; no hidden environment switch gates the watcher', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /CAT_CAFE_WATCHER_ENABLED/);
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  let constructed = 0;
  let guardedByIf = false;
  const walk = (node, insideIf) => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'WatcherSupervisor') {
      constructed++;
      guardedByIf ||= insideIf;
    }
    ts.forEachChild(node, (child) => walk(child, insideIf || ts.isIfStatement(node)));
  };
  walk(source, false);
  assert.equal(constructed, 1);
  assert.equal(guardedByIf, false, 'the settings switch is the only on/off control');
});
