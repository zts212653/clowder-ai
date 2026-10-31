import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FLAT_MESSAGE_WRITERS = new Set(['addMessage', 'replaceMessages', 'clearMessages']);

const FLAT_WRITER_EXEMPTIONS = new Map([
  [
    'src/hooks/useAgentMessages.ts',
    'Socket messages pass the active-thread dispatch gate before synchronous flat projection; background and deferred paths use their own thread guards.',
  ],
]);

function collectCalledNames(relativePath: string): string[] {
  const absolutePath = resolve(process.cwd(), relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(absolutePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calledNames: string[] = [];
  const aliases = new Map<string, string>();

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const property = element.propertyName;
        const originalName =
          property && (ts.isIdentifier(property) || ts.isStringLiteral(property)) ? property.text : element.name.text;
        aliases.set(element.name.text, originalName);
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        calledNames.push(aliases.get(node.expression.text) ?? node.expression.text);
      }
      if (ts.isPropertyAccessExpression(node.expression)) calledNames.push(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calledNames;
}

function collectSourceFiles(relativeRoot: string): string[] {
  const files: string[] = [];
  const root = resolve(process.cwd(), relativeRoot);

  function visit(directory: string) {
    for (const entry of readdirSync(directory)) {
      if (entry === '__tests__') continue;
      const absolutePath = resolve(directory, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        visit(absolutePath);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        files.push(relative(process.cwd(), absolutePath));
      }
    }
  }

  visit(root);
  return files.sort();
}

function collectFlatWriterViolations(): string[] {
  const sourceFiles = [...collectSourceFiles('src/hooks'), ...collectSourceFiles('src/components')];
  const violations: string[] = [];

  for (const relativePath of sourceFiles) {
    if (FLAT_WRITER_EXEMPTIONS.has(relativePath)) continue;
    const flatCalls = collectCalledNames(relativePath).filter((name) => FLAT_MESSAGE_WRITERS.has(name));
    for (const writer of new Set(flatCalls)) violations.push(`${relativePath}: ${writer}`);
  }

  return violations;
}

describe('thread projection writer boundary', () => {
  it('recognizes a destructured flat writer even when the call uses an alias', () => {
    const calledNames = collectCalledNames('src/hooks/__tests__/fixtures/thread-projection-flat-writer-alias.ts');
    expect(calledNames).toContain('addMessage');
  });

  it('scans every production hook and component for flat message writers', () => {
    expect(collectFlatWriterViolations()).toEqual([]);
  });

  it('keeps every exemption live and justified', () => {
    const sourceFiles = new Set([...collectSourceFiles('src/hooks'), ...collectSourceFiles('src/components')]);
    expect(
      [...FLAT_WRITER_EXEMPTIONS].filter(
        ([relativePath, reason]) => !sourceFiles.has(relativePath) || reason.trim().length === 0,
      ),
    ).toEqual([]);
  });

  it('forbids flat writers in route-scoped send completions', () => {
    const calledNames = collectCalledNames('src/hooks/useSendMessage.ts');
    expect(calledNames).not.toContain('addMessage');
    expect(calledNames).not.toContain('setLoading');
    expect(calledNames).not.toContain('setHasActiveInvocation');
  });

  it('forbids flat writers in command and component async completions with a captured thread', () => {
    const commandCalls = collectCalledNames('src/hooks/useChatCommands.ts');
    const inputCalls = collectCalledNames('src/components/ChatInput.tsx');
    const containerCalls = collectCalledNames('src/components/ChatContainer.tsx');
    expect(commandCalls).not.toContain('addMessage');
    expect(inputCalls).not.toContain('addMessage');
    expect(containerCalls).not.toContain('addMessage');
  });

  it('forbids flat writers in thread-scoped history hydration', () => {
    const calledNames = collectCalledNames('src/hooks/useChatHistory.ts');
    expect(calledNames).not.toContain('replaceMessages');
    expect(calledNames).not.toContain('clearMessages');
    expect(calledNames).not.toContain('setLoadingHistory');
  });
});
