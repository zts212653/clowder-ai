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
  assert.equal(callbacks.length, 5, 'exercise startup, invocation, receipt and both finalization hooks');
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

test('the actual rollout-off recovery callback never invokes a provider for an unresolved native attempt', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  let callback;
  const walk = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'reconcileWatcherRecovery')
      callback = node.arguments[0].properties
        .find((p) => p.name?.getText(source) === 'recoverNative')
        .initializer.getText(source);
    ts.forEachChild(node, walk);
  };
  walk(source);
  let launches = 0,
    idle = 0;
  const recover = vm.runInNewContext(
    ts.transpileModule(`const handler=${callback};handler;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      registry: {},
      turnExecutionStore: {},
      sessionChainStore: {},
      finishIdleWatcherWake: async () => {
        idle++;
      },
      router: { getStrategyDeps: () => ({ services: { codex: {} } }) },
      runWatcherInvocation: async () => {
        launches++;
      },
      threadStore: {},
      messageStore: {},
      transcriptWriter: {},
      PORT: 3102,
      watcherMaySpeak: () => false,
    },
  );
  await recover({ catId: 'codex', watcherState: { attempt: { phase: 'failed' } } }, {});
  assert.equal(launches, 0);
  assert.equal(idle, 0, 'unproved native state remains pending');
  await recover({ catId: 'codex', watcherState: {} }, {});
  assert.equal(launches, 0);
  assert.equal(idle, 1, 'only the existing idle proof can perform owner-only settlement');
});
