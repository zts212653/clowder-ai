import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

// Expand only arrays reachable from ENV_VARS. Never execute registry imports or
// scan unrelated files/objects: an unreferenced definition is not registered.
export function loadEnvRegistrySource(registryPath) {
  const entry = realpathSync(registryPath);
  const root = dirname(entry);
  const modules = new Map();
  const visiting = new Set();

  function load(file) {
    const canonical = realpathSync(file);
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
      throw new Error(`Registry array import escapes its directory: ${file}`);
    }
    if (!modules.has(canonical)) {
      const source = readFileSync(canonical, 'utf8');
      const ast = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const variables = new Map();
      const imports = new Map();
      for (const statement of ast.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer) {
              variables.set(declaration.name.text, declaration.initializer);
            }
          }
        }
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly) {
            imports.set(binding.name.text, {
              specifier: statement.moduleSpecifier.text,
              name: binding.propertyName?.text ?? binding.name.text,
            });
          }
        }
      }
      modules.set(canonical, { file: canonical, source, ast, variables, imports });
    }
    return modules.get(canonical);
  }

  function unwrap(node) {
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      node = node.expression;
    }
    return node;
  }

  function expandNamed(module, name) {
    const key = `${module.file}:${name}`;
    if (visiting.has(key)) throw new Error(`Cyclic registry array: ${key}`);
    visiting.add(key);
    try {
      const local = module.variables.get(name);
      if (local) return expandArray(module, unwrap(local));
      const imported = module.imports.get(name);
      if (!imported || !/^\.\.?\//.test(imported.specifier) || !/\.(?:js|ts)$/.test(imported.specifier)) {
        throw new Error(`Unsupported registry array reference: ${key}`);
      }
      const file = resolve(dirname(module.file), imported.specifier.replace(/\.js$/, '.ts'));
      return expandNamed(load(file), imported.name);
    } finally {
      visiting.delete(key);
    }
  }

  function expandArray(module, node) {
    if (ts.isIdentifier(node)) return expandNamed(module, node.text);
    if (!ts.isArrayLiteralExpression(node)) throw new Error(`Expected static registry array in ${module.file}`);
    return node.elements.flatMap((element) => {
      const value = unwrap(element);
      if (ts.isObjectLiteralExpression(value)) return [value.getText(module.ast)];
      if (ts.isSpreadElement(value)) return expandArray(module, unwrap(value.expression));
      throw new Error(`Unsupported registry entry in ${module.file}: ${value.getText(module.ast)}`);
    });
  }

  const module = load(entry);
  const initializer = module.variables.get('ENV_VARS');
  if (!initializer) throw new Error('Registry must declare ENV_VARS');
  const entries = expandNamed(module, 'ENV_VARS');
  return `${module.source.slice(0, initializer.getStart(module.ast))}[\n${entries.join(',\n')}\n]${module.source.slice(initializer.end)}`;
}
