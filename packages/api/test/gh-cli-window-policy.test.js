import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = join(API_ROOT, 'src');

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function optionsHideWindow(node, source) {
  const options = node.arguments.length >= 3 ? node.arguments[2] : node.arguments[1];
  if (!options) return false;
  const text = options.getText(source);
  return (
    text.includes('withHiddenGhCliWindow') ||
    text.includes('getGitHubExecOptions') ||
    (ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(source) === 'windowsHide' &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ))
  );
}

// A local adapter may accept a buffer budget as argument 3 rather than Node options.
// Follow its command parameter to every forwarding call instead of treating the budget as options.
function localAdapterHidesWindow(call, source) {
  if (!ts.isIdentifier(call.expression)) return false;
  let adapter;
  for (let scope = call.parent; scope && !adapter; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    adapter = scope.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === call.expression.text && statement.body,
    );
    if (
      !adapter &&
      scope.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === call.expression.text,
          ),
      )
    )
      return false;
  }
  const command = adapter?.parameters[0]?.name;
  if (!command || !ts.isIdentifier(command)) return false;
  const forwards = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.arguments[0] ?? {}) &&
      node.arguments[0].text === command.text
    )
      forwards.push(optionsHideWindow(node, source));
    ts.forEachChild(node, visit);
  }
  visit(adapter.body);
  return forwards.length > 0 && forwards.every(Boolean);
}

describe('gh CLI child-process policy', () => {
  it('hides every direct Node gh invocation on Windows', () => {
    const ghCalls = [];

    for (const path of collectTypeScriptFiles(SOURCE_ROOT)) {
      const sourceText = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);

      function visit(node) {
        if (ts.isCallExpression(node)) {
          const command = node.arguments[0];
          if (command && ts.isStringLiteral(command) && command.text === 'gh') {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            ghCalls.push({
              location: `${relative(API_ROOT, path)}:${line}`,
              hidden: optionsHideWindow(node, source) || localAdapterHidesWindow(node, source),
            });
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(source);
    }

    assert.ok(ghCalls.length > 0, 'expected to find direct gh child-process calls');
    assert.deepEqual(
      ghCalls.filter((call) => !call.hidden).map((call) => call.location),
      [],
      'all direct gh child-process calls must use hidden-window process options',
    );
  });

  it('rejects a local adapter that forwards gh without hiding the actual child window', () => {
    for (const hidden of ['', 'windowsHide: false,', 'windowsHide: true,']) {
      const source = ts.createSourceFile(
        'fixture.ts',
        `async function run(command, args, budget) { return execute(command, args, { ${hidden} maxBuffer: budget }); }
run('gh', ['api'], 4096);`,
        ts.ScriptTarget.Latest,
        true,
      );
      const call = source.statements[1].expression;
      assert.equal(localAdapterHidesWindow(call, source), hidden.includes('true'));
    }
  });

  it('does not borrow hidden-window options from a same-name adapter in another scope', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `function safe() {
        function run(command, args, budget) { return execute(command, args, {windowsHide: true, maxBuffer: budget}); }
      }
      function unsafe() {
        function run(command, args, budget) { return execute(command, args, {maxBuffer: budget}); }
        run('gh', ['api'], 4096);
      }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const call = source.statements[1].body.statements[1].expression;
    assert.equal(localAdapterHidesWindow(call, source), false);
  });
});
