import { posix } from 'node:path';
import ts from 'typescript';

function moduleRef(specifier, file) {
  if (specifier === 'node:child_process' || specifier === 'child_process') return { module: 'process' };
  if (specifier === 'node:module' || specifier === 'module') return { module: 'module' };
  if (specifier === 'node:process' || specifier === 'process') return { module: 'node-process' };
  const local = specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), specifier)) : '';
  if (local.replace(/\.[cm]?[jt]sx?$/u, '') === 'packages/api/src/utils/cli-process-ownership')
    return { module: 'snapshot' };
}

function memberRef(base, name) {
  if (!base?.module || base.member) return;
  if (base.module === 'module' && name === 'createRequire') return { kind: 'create-require' };
  if (base.module === 'node-process' && name === 'getBuiltinModule') return { kind: 'loader' };
  return { module: base.module, member: name };
}

function parsedSource(file, text) {
  const name = `/${file}`;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`${file}: cannot parse source for synchronous-call scan`);
  const options = { noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.Latest };
  const host = {
    ...ts.createCompilerHost(options),
    getCurrentDirectory: () => '/',
    getSourceFile: (path) => (path === name ? source : undefined),
    readFile: (path) => (path === name ? text : undefined),
    fileExists: (path) => path === name,
  };
  return { source, checker: ts.createProgram([name], options, host).getTypeChecker() };
}

function importEntries(clause) {
  const entries = [];
  if (clause.name) entries.push({ name: clause.name });
  const names = clause.namedBindings;
  if (names && ts.isNamespaceImport(names)) entries.push({ name: names.name });
  if (names && ts.isNamedImports(names))
    for (const entry of names.elements)
      if (!entry.isTypeOnly) entries.push({ name: entry.name, member: entry.propertyName?.text ?? entry.name.text });
  return entries;
}

function bindImports(source, file, bind) {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const value = moduleRef(statement.moduleSpecifier.text, file);
    for (const entry of importEntries(clause)) bind(entry.name, entry.member ? memberRef(value, entry.member) : value);
  }
}

function builtinLoader(callee, checker) {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === 'require' && !checker.getSymbolAtLocation(callee);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== 'getBuiltinModule' || !ts.isIdentifier(callee.expression)) return false;
  return callee.expression.text === 'process' && !checker.getSymbolAtLocation(callee.expression);
}

function callReference(node, ref, checker, file) {
  const callee = ref(node.expression);
  if (callee?.kind === 'create-require') return { kind: 'loader' };
  if (callee?.kind !== 'loader' && !builtinLoader(node.expression, checker)) return;
  const argument = node.arguments[0];
  if (argument && ts.isStringLiteral(argument)) return moduleRef(argument.text, file);
}

function constantDeclarations(source) {
  const declarations = [];
  function gather(node) {
    if (ts.isVariableDeclaration(node) && node.parent.flags & ts.NodeFlags.Const) declarations.push(node);
    ts.forEachChild(node, gather);
  }
  gather(source);
  return declarations;
}

function bindDeclaration(declaration, ref, bind, source) {
  const value = ref(declaration.initializer);
  if (ts.isIdentifier(declaration.name)) return bind(declaration.name, value);
  if (!ts.isObjectBindingPattern(declaration.name)) return false;
  let changed = false;
  for (const entry of declaration.name.elements) {
    if (!ts.isIdentifier(entry.name) || entry.dotDotDotToken) continue;
    changed = bind(entry.name, memberRef(value, entry.propertyName?.getText(source) ?? entry.name.text)) || changed;
  }
  return changed;
}

/** Local compiler symbols distinguish real imports from identically named parameters. */
export function syncCallSource(file, text) {
  const { source, checker } = parsedSource(file, text);
  const bindings = new Map();
  const bind = (name, value) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol || !value || bindings.has(symbol)) return false;
    bindings.set(symbol, value);
    return true;
  };
  bindImports(source, file, bind);
  function ref(node) {
    if (!node) return;
    if (ts.isIdentifier(node)) return bindings.get(checker.getSymbolAtLocation(node));
    const transparent =
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node);
    if (transparent) return ref(node.expression);
    if (ts.isPropertyAccessExpression(node)) return memberRef(ref(node.expression), node.name.text);
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression))
      return memberRef(ref(node.expression), node.argumentExpression.text);
    if (ts.isCallExpression(node)) return callReference(node, ref, checker, file);
  }
  const declarations = constantDeclarations(source);
  for (let pass = 0; pass <= declarations.length; pass++) {
    let changed = false;
    for (const declaration of declarations) changed = bindDeclaration(declaration, ref, bind, source) || changed;
    if (!changed) break;
  }
  return { source, reference: ref };
}
