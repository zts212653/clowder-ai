import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Extract and execute the real startup callback without booting index.ts or Redis.
// Source layout and unrelated diagnostics may change; observable ordering may not.
export async function assertHostListenLifecycle(source, releaseName) {
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const callbacks = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'listen' && ts.isArrowFunction(node.initializer)) {
      let callsAppListen = false;
      const findCall = (child) => {
        if (ts.isCallExpression(child) && child.expression.getText(file) === 'app.listen') callsAppListen = true;
        ts.forEachChild(child, findCall);
      };
      findCall(node.initializer);
      if (callsAppListen) callbacks.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(callbacks.length, 1, 'production must have one Host listen callback');
  const javascript = ts.transpileModule(`(${callbacks[0].getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  function fixture() {
    const listening = deferred();
    const activation = deferred();
    const calls = [];
    const callback = runInNewContext(
      javascript,
      {
        app: {
          listen: () => {
            calls.push('listen');
            return listening.promise;
          },
          log: new Proxy({}, { get: () => () => {} }),
        },
        PORT: 0,
        HOST: '127.0.0.1',
        startupMilestone() {},
        processCpuCapture: undefined,
        startProcessCpuCapture() {},
        process: { env: {} },
        homedir: () => '/isolated-fixture',
        join,
        [releaseName]: () => calls.push('release'),
        initialPlugins: {
          activate: () => {
            calls.push('activate');
            return activation.promise;
          },
        },
      },
      { timeout: 1000 },
    );
    return { callback, listening, activation, calls };
  }

  const success = fixture();
  let settled = false;
  const result = success.callback().then((value) => {
    settled = true;
    return value;
  });
  result.catch(() => {});
  assert.deepEqual(success.calls, ['listen'], 'neither windows nor plugins may start before listening succeeds');
  success.listening.resolve('fixture-listening-address');
  await setImmediate();
  assert.deepEqual(
    success.calls,
    ['listen', 'release'],
    'listening releases background work without inline activation',
  );
  assert.equal(settled, true, 'HTTP startup must not await optional initial plugin activation');
  success.activation.resolve();
  assert.equal(await result, 'fixture-listening-address');

  const failure = fixture();
  const rejected = failure.callback();
  failure.listening.reject(new Error('fixture listen failure'));
  await assert.rejects(rejected, /fixture listen failure/);
  assert.deepEqual(failure.calls, ['listen'], 'failed listening must never release windows or activate plugins');
}
