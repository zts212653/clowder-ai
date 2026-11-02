import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(packageRoot, '../..');
const output = resolve(packageRoot, 'dist/runtime');
// These are retired generated MCP wrappers, never user files. Do not ship
// stale compiled entrypoints after an incremental build of their removal.
for (const name of [
  'secret-mcp-config',
  'secret-mcp-proxy',
  'secret-mcp-wire',
  'secret-remote-transport',
  'shared-json-transport',
  'shared-mcp-aggregate',
]) {
  for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map'])
    rmSync(resolve(packageRoot, 'dist', name + suffix), { force: true });
}
const entries = [
  'scripts/lib/secret-tool-io.mjs',
  'scripts/lib/secret-value-inspection.mjs',
  'scripts/lib/secret-credential-paths.mjs',
  'scripts/secret-native-hook.mjs',
  'scripts/secret-kimi-hook.mjs',
  'scripts/secret-opencode-plugin.mjs',
  'scripts/secret-dsh-plugin.mjs',
  'scripts/native-effect-target-guard.mjs',
  'scripts/agy-native-effect-guard.mjs',
  'scripts/guarded-bin/gh',
  'scripts/guarded-bin/curl',
];
const inputs = new Map();
const sharedDefaults = new Set([
  'packages/shared/src/deployment-defaults.ts',
  'packages/shared/src/deployment-profiles.json',
]);
const portable = (path) => path.split(sep).join('/');
const emittedPath = (file) => file.replace(/\.ts$/, '.mjs');
function inside(root, path) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function collect(file) {
  if (inputs.has(file)) return;
  const path = resolve(repository, file);
  if (!inside(resolve(repository, 'scripts'), path) && !sharedDefaults.has(file))
    throw new Error(`Secret runtime input is outside its declared source closure: ${file}`);
  let code = readFileSync(path, 'utf8');
  const imports = file.endsWith('.json') ? [] : ts.preProcessFile(code, true, true).importedFiles;
  inputs.set(file, code);
  for (const dependency of imports) {
    const name = dependency.fileName;
    if (!name.startsWith('.')) {
      if (!name.startsWith('node:')) throw new Error(`Secret runtime has an undeclared dependency: ${name}`);
      continue;
    }
    const target = resolve(dirname(path), name);
    // The source hook and its packaged copy call the very same MCP module.
    if (inside(resolve(packageRoot, 'dist'), target)) {
      code = code.replaceAll(name, portable(relative(dirname(resolve(output, file)), target)));
      continue;
    }
    const sourceFile = portable(relative(repository, target));
    collect(sourceFile);
    code = code.replaceAll(name, emittedPath(name));
  }
  inputs.set(file, code);
  const declaration = path.replace(/\.mjs$/, '.d.mts');
  if (declaration !== path && existsSync(declaration))
    inputs.set(portable(relative(repository, declaration)), readFileSync(declaration, 'utf8'));
}
for (const entry of entries) collect(entry);
for (const file of [
  'assets/agy-native-tool-vocabulary.json',
  ...['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((name) => `scripts/guarded-zsh/${name}`),
])
  inputs.set(file, readFileSync(resolve(repository, file), 'utf8'));
// This directory contains generated build assets only, never user state.
rmSync(output, { recursive: true, force: true });
for (const [file, code] of inputs) {
  const target = resolve(output, emittedPath(file));
  mkdirSync(dirname(target), { recursive: true });
  // Installed dependencies cannot rely on Node stripping TypeScript in node_modules.
  const emitted = file.endsWith('.ts')
    ? ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText
    : code;
  writeFileSync(target, emitted, { mode: statSync(resolve(repository, file)).mode });
}
console.log(`Secret runtime: staged ${inputs.size} package-local inputs`);
