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

describe('gh CLI child-process policy', () => {
  it('hides every direct Node gh invocation on Windows', () => {
    const ghCalls = [];

    for (const path of collectTypeScriptFiles(SOURCE_ROOT)) {
      const sourceText = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);

      function getOptionsArgument(node) {
        if (node.arguments.length >= 3) return node.arguments[2];
        if (node.arguments.length === 2 && !ts.isArrayLiteralExpression(node.arguments[1])) return node.arguments[1];
        return undefined;
      }

      function visit(node) {
        if (ts.isCallExpression(node)) {
          const command = node.arguments[0];
          if (command && ts.isStringLiteral(command) && command.text === 'gh') {
            const options = getOptionsArgument(node);
            const optionsText = options?.getText(source) ?? '';
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            ghCalls.push({
              location: `${relative(API_ROOT, path)}:${line}`,
              hidden: optionsText.includes('withHiddenGhCliWindow') || optionsText.includes('getGitHubExecOptions'),
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
      'all direct gh child-process calls must use the shared hidden-window options',
    );
  });
});
