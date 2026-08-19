import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { createProtectedBaseSnapshot, type LegacyServerToolsets } from './tool-governance-protected-base.js';
import type { McpSurfaceSnapshot } from './tool-governance-snapshot.js';
import type { McpImplementationBinding, McpToolDefinition } from './tool-governance-types.js';

const run = promisify(execFile);

function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return env;
}

async function execute(command: string, args: readonly string[], cwd: string): Promise<void> {
  try {
    await run(command, [...args], { cwd, env: commandEnv(), maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const output = [detail.stdout, detail.stderr].filter((value) => value?.trim()).join('\n');
    throw new Error(`Protected-base command failed: ${command} ${args.join(' ')}\n${output || detail.message || ''}`);
  }
}

function parsedRef(ref: McpImplementationBinding['ref']): { modulePath: string; exportName: string } {
  const match = /^module:(.+)#([^#]+)$/.exec(ref);
  if (!match?.[1] || !match[2] || !match[1].startsWith('./')) {
    throw new Error(`Invalid implementation ref: ${ref}`);
  }
  return { modulePath: match[1].slice(2), exportName: match[2] };
}

async function moduleDigest(checkout: string, ref: McpImplementationBinding['ref']): Promise<string> {
  const source = parsedRef(ref).modulePath.replace(/\.js$/, '.ts');
  const content = await readFile(resolve(checkout, 'packages/mcp-server/src', source));
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = object.properties.find((candidate) => propertyName(candidate) === name);
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

function handlerExpressions(sourceFile: ts.SourceFile, toolName: string): readonly ts.Expression[] {
  const handlers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const name = propertyInitializer(node, 'name');
      if (name && ts.isStringLiteral(name) && name.text === toolName) {
        const handler = propertyInitializer(node, 'handler');
        if (handler) handlers.push(handler);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return handlers;
}

function verifyStaticProtectedBinding(input: {
  checkout: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  toolName: string;
  ref: McpImplementationBinding['ref'];
}): void {
  const expected = parsedRef(input.ref);
  const sourcePath = resolve(input.checkout, 'packages/mcp-server/src', expected.modulePath.replace(/\.js$/, '.ts'));
  const sourceFile = input.program.getSourceFile(sourcePath);
  if (!sourceFile) throw new Error(`Protected-base implementation module is outside compiler graph: ${input.ref}`);
  const handlers = handlerExpressions(sourceFile, input.toolName);
  const expression = handlers.length === 1 ? handlers[0] : undefined;
  if (!expression) {
    throw new Error(
      `Protected-base handler binding is ambiguous: ${input.toolName} -> ${input.ref} (${handlers.length} matches)`,
    );
  }
  const initialSymbol = input.checker.getSymbolAtLocation(expression);
  const symbol =
    initialSymbol && initialSymbol.flags & ts.SymbolFlags.Alias
      ? input.checker.getAliasedSymbol(initialSymbol)
      : initialSymbol;
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) {
    throw new Error(`Protected-base handler symbol is unresolved: ${input.toolName} -> ${input.ref}`);
  }
  const declarationFile = declaration.getSourceFile();
  if (symbol.getName() !== expected.exportName || declarationFile.fileName !== sourceFile.fileName) {
    const position = declarationFile.getLineAndCharacterOfPosition(declaration.getStart(declarationFile));
    const actual = `${relative(input.checkout, declarationFile.fileName)}#${symbol.getName()}@${position.line + 1}:${position.character + 1}`;
    throw new Error(`Protected-base handler identity mismatch: ${input.toolName} -> ${input.ref}; actual ${actual}`);
  }
}

function createProtectedBindingVerifier(checkout: string) {
  const repoRoot = resolve(checkout);
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'packages/mcp-server/tsconfig.json');
  if (!configPath) throw new Error('Unable to find protected packages/mcp-server/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  return async (
    toolName: string,
    handler: McpImplementationBinding['run'],
    ref: McpImplementationBinding['ref'],
  ): Promise<void> => {
    const expected = parsedRef(ref);
    const runtimeUrl = pathToFileURL(resolve(checkout, 'packages/mcp-server/dist', expected.modulePath)).href;
    const runtimeModule = (await import(runtimeUrl)) as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(runtimeModule, expected.exportName)) {
      if (runtimeModule[expected.exportName] !== handler) {
        throw new Error(`Protected-base handler identity mismatch: ${toolName} -> ${ref}`);
      }
      return;
    }
    verifyStaticProtectedBinding({ checkout, program, checker, toolName, ref });
  };
}

export async function createProtectedSnapshotFromWorktree(input: {
  repoRoot: string;
  protectedBaseSha: string;
  currentSnapshot: McpSurfaceSnapshot;
  currentDefinitions: readonly McpToolDefinition[];
}): Promise<McpSurfaceSnapshot> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'f286-protected-base-'));
  const checkout = join(temporaryRoot, 'checkout');
  let worktreeAdded = false;
  try {
    await execute('git', ['worktree', 'add', '--detach', checkout, input.protectedBaseSha], input.repoRoot);
    worktreeAdded = true;
    await execute('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], checkout);
    await execute('pnpm', ['--filter', '@cat-cafe/mcp-server...', 'build'], checkout);

    const toolsetsUrl = pathToFileURL(resolve(checkout, 'packages/mcp-server/dist/server-toolsets.js')).href;
    const legacy = (await import(toolsetsUrl)) as LegacyServerToolsets;
    const verifyImplementationBinding = createProtectedBindingVerifier(checkout);
    return await createProtectedBaseSnapshot(input.currentSnapshot, input.currentDefinitions, legacy, {
      protectedBaseSha: input.protectedBaseSha,
      verifyImplementationBinding,
      implementationDigest: (ref) => moduleDigest(checkout, ref),
    });
  } finally {
    if (worktreeAdded) {
      await execute('git', ['worktree', 'remove', '--force', checkout], input.repoRoot);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
