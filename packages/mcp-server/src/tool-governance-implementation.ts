import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import type {
  McpImplementationBinding,
  McpToolDefinition,
  ResolvedImplementationCatalog,
} from './tool-governance-types.js';

export type RuntimeModuleLoader = (
  moduleRef: McpImplementationBinding['ref'],
) => Promise<Readonly<Record<string, unknown>>>;

export type ImplementationResolutionInput = {
  repoRoot: string;
  definitions: readonly McpToolDefinition[];
  loadRuntimeModule?: RuntimeModuleLoader;
};

type ParsedRef = {
  ref: McpImplementationBinding['ref'];
  moduleSpecifier: string;
  exportName: string;
};

function parseRef(ref: McpImplementationBinding['ref']): ParsedRef {
  const match = /^module:(.+)#([^#]+)$/.exec(ref);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid MCP implementation binding: ${ref}`);
  return { ref, moduleSpecifier: match[1], exportName: match[2] };
}

function compilerProgram(
  repoRoot: string,
  moduleSpecifiers: readonly string[],
): { program: ts.Program; options: ts.CompilerOptions } {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'packages/mcp-server/tsconfig.json');
  if (!configPath) throw new Error('Unable to find packages/mcp-server/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const containingFile = resolve(repoRoot, 'packages/mcp-server/src/__mcp_governance_resolver__.ts');
  const bindingFiles = moduleSpecifiers.map((moduleSpecifier) => {
    const resolution = ts.resolveModuleName(moduleSpecifier, containingFile, parsed.options, ts.sys).resolvedModule;
    if (!resolution) throw new Error(`Unresolved MCP implementation module: ${moduleSpecifier}`);
    return resolution.resolvedFileName;
  });
  return {
    program: ts.createProgram([...new Set([...parsed.fileNames, ...bindingFiles])], parsed.options),
    options: parsed.options,
  };
}

function resolveSourceFile(
  repoRoot: string,
  moduleSpecifier: string,
  program: ts.Program,
  options: ts.CompilerOptions,
): ts.SourceFile {
  const containingFile = resolve(repoRoot, 'packages/mcp-server/src/__mcp_governance_resolver__.ts');
  const resolution = ts.resolveModuleName(moduleSpecifier, containingFile, options, ts.sys).resolvedModule;
  if (!resolution) throw new Error(`Unresolved MCP implementation module: ${moduleSpecifier}`);
  const sourceFile = program.getSourceFile(resolution.resolvedFileName.replace(/\.js$/, '.ts'));
  if (!sourceFile) throw new Error(`MCP implementation module is outside the compiler graph: ${moduleSpecifier}`);
  return sourceFile;
}

function resolveExport(program: ts.Program, sourceFile: ts.SourceFile, exportName: string): ts.Symbol {
  const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol
    ? program
        .getTypeChecker()
        .getExportsOfModule(moduleSymbol)
        .find((symbol) => symbol.getName() === exportName)
    : undefined;
  if (!exported) throw new Error(`MCP implementation export does not exist: ${sourceFile.fileName}#${exportName}`);
  return exported;
}

function compilerSymbolId(repoRoot: string, sourceFile: ts.SourceFile, symbol: ts.Symbol): string {
  const declaration = symbol.declarations?.[0];
  const position = declaration ? sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)) : undefined;
  const coordinate = position ? `${position.line + 1}:${position.character + 1}` : 'export';
  return `${relative(repoRoot, sourceFile.fileName)}#${symbol.getName()}@${coordinate}`;
}

function defaultRuntimeLoader(repoRoot: string): RuntimeModuleLoader {
  return async (ref) => {
    const { moduleSpecifier } = parseRef(ref);
    if (!moduleSpecifier.startsWith('./')) {
      throw new Error(`MCP implementation modules must be package-relative: ${moduleSpecifier}`);
    }
    const relativeModule = moduleSpecifier.slice(2);
    const modulePath = resolve(repoRoot, 'packages/mcp-server/dist', relativeModule);
    return import(modulePath) as Promise<Readonly<Record<string, unknown>>>;
  };
}

export async function resolveMcpImplementationCatalog(
  input: ImplementationResolutionInput,
): Promise<ResolvedImplementationCatalog> {
  const parsedRefs = input.definitions.map((definition) => parseRef(definition.implementation.ref));
  const { program, options } = compilerProgram(
    input.repoRoot,
    parsedRefs.map((parsed) => parsed.moduleSpecifier),
  );
  const loadRuntimeModule = input.loadRuntimeModule ?? defaultRuntimeLoader(input.repoRoot);
  const catalog = new Map<
    McpImplementationBinding['ref'],
    { moduleDigest: string; exportName: string; compilerSymbolId: string }
  >();
  const failures: string[] = [];
  for (const definition of input.definitions) {
    try {
      const parsed = parseRef(definition.implementation.ref);
      const sourceFile = resolveSourceFile(input.repoRoot, parsed.moduleSpecifier, program, options);
      const exported = resolveExport(program, sourceFile, parsed.exportName);
      const runtimeModule = await loadRuntimeModule(parsed.ref);
      if (runtimeModule[parsed.exportName] !== definition.implementation.run) {
        throw new Error(`MCP implementation identity mismatch: ${definition.name} -> ${parsed.ref}`);
      }
      const moduleDigest = `sha256:${createHash('sha256')
        .update(await readFile(sourceFile.fileName))
        .digest('hex')}`;
      catalog.set(parsed.ref, {
        moduleDigest,
        exportName: parsed.exportName,
        compilerSymbolId: compilerSymbolId(input.repoRoot, sourceFile, exported),
      });
    } catch (error) {
      failures.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`MCP implementation resolution failed:\n${failures.join('\n')}`);
  return catalog;
}
