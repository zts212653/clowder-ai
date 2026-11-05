import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';

test('the actual index shutdown registration precedes listen and accepts its late-bound detach handle', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  let declaration, hook, listen;
  const visit = (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((value) => value.name.getText(file) === 'detachManagedWaitEvents')
    )
      declaration = node;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === 'app'
    ) {
      if (node.expression.name.text === 'listen') listen ??= node;
      if (
        node.expression.name.text === 'addHook' &&
        node.arguments[0]?.getText(file) === "'onClose'" &&
        node.arguments[1]?.getText(file).includes('detachManagedWaitEvents')
      )
        hook = node.parent;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(declaration && hook && listen);
  assert.ok(declaration.pos < hook.pos && hook.pos < listen.pos, 'Fastify rejects hooks added after listen');
  const actualRegistration = ts.transpileModule(`${declaration.getText(file)}\n${hook.getText(file)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const app = Fastify();
  let detached = 0;
  try {
    const bind = new Function('app', `${actualRegistration}\nreturn handle => { detachManagedWaitEvents = handle; };`)(
      app,
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    bind(() => {
      detached++;
    });
  } finally {
    await app.close();
  }
  assert.equal(detached, 1);
});
