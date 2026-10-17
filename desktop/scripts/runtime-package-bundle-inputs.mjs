import { createRequire } from 'node:module';
import path from 'node:path';

const ts = createRequire(import.meta.url)('typescript');
const string = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
const metaUrl = (node) =>
  ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression);

function trackedFactoryInitializer(call, loaders, unsupported) {
  const binding = call.parent;
  if (
    !ts.isVariableDeclaration(binding) ||
    binding.initializer !== call ||
    !ts.isIdentifier(binding.name) ||
    !loaders.has(binding.name.text)
  )
    unsupported();
}

function loaderReference(node, factories, loaders, requires, unsupported) {
  if (!ts.isIdentifier(node) || (!loaders.has(node.text) && !factories.has(node.text) && node.text !== 'require'))
    return;
  const parent = node.parent;
  if ((ts.isVariableDeclaration(parent) && parent.name === node) || ts.isImportSpecifier(parent)) return;
  if (!ts.isCallExpression(parent) || parent.expression !== node) unsupported();
  if (factories.has(node.text)) {
    trackedFactoryInitializer(parent, loaders, unsupported);
    return;
  }
  if (loaders.has(node.text)) {
    if (parent.arguments.length !== 1 || !string(parent.arguments[0])) unsupported();
    requires.push(parent.arguments[0].text);
  } else if (node.text === 'require' && !factories.has(node.text)) unsupported();
}

/** Preserve each module's original asset/require base; reject opaque loader edges. */
export function runtimePackageInput(code, file, outdir) {
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const factories = new Set(),
    loaders = new Set(),
    replacements = [],
    requires = [];
  const unsupported = () => {
    throw new Error(`Unsupported runtime package loader or import.meta: ${file}`);
  };
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ['node:module', 'module'].includes(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || node.importClause.name) unsupported();
      for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text !== 'createRequire') unsupported();
        factories.add(item.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const collectLoaders = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      factories.has(node.initializer.expression.text)
    ) {
      if (node.initializer.arguments.length !== 1 || !metaUrl(node.initializer.arguments[0])) unsupported();
      loaders.add(node.name.text);
    }
    ts.forEachChild(node, collectLoaders);
  };
  collectLoaders(tree);
  const visit = (node) => {
    if (ts.isMetaProperty(node)) {
      if (!metaUrl(node.parent)) unsupported();
      const relative = `./${path.relative(outdir, file).replaceAll('\\', '/')}`;
      replacements.push([
        node.parent.getStart(tree),
        node.parent.end,
        `new URL(${JSON.stringify(relative)}, import.meta.url).href`,
      ]);
    }
    loaderReference(node, factories, loaders, requires, unsupported);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      (node.arguments.length !== 1 || !string(node.arguments[0]))
    )
      unsupported();
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const [start, end, value] of replacements.sort((left, right) => right[0] - left[0]))
    code = code.slice(0, start) + value + code.slice(end);
  return { code, requires };
}
