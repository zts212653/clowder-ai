import ts from 'typescript';

function unwrapExpression(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializer = unwrapExpression(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return initializer;
}

function propertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) return property.name.text;
  return undefined;
}

function objectProperties(object) {
  const properties = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property);
    if (name) properties.set(name, unwrapExpression(property.initializer));
  }
  return properties;
}

function staticStringValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(unwrapExpression(node.left));
    const right = staticStringValue(unwrapExpression(node.right));
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function parseSource(src) {
  return ts.createSourceFile('env-registry.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function parseCategories(src) {
  const categories = new Map();
  const initializer = findVariableInitializer(parseSource(src), 'ENV_CATEGORIES');
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return categories;
  for (const [key, valueNode] of objectProperties(initializer)) {
    const value = staticStringValue(valueNode);
    if (value !== undefined) categories.set(key, value);
  }
  return categories;
}

export function parseVars(src) {
  const vars = [];
  const initializer = findVariableInitializer(parseSource(src), 'ENV_VARS');
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return vars;
  for (const element of initializer.elements) {
    const value = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(value)) continue;
    const properties = objectProperties(value);
    const name = staticStringValue(properties.get('name'));
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;

    vars.push({
      name,
      category: staticStringValue(properties.get('category')) ?? 'unknown',
      defaultValue: staticStringValue(properties.get('defaultValue')) ?? '—',
      description: staticStringValue(properties.get('description'))?.replace(/\n\s*/g, ' ') ?? '',
      sensitive: properties.get('sensitive')?.kind === ts.SyntaxKind.TrueKeyword,
    });
  }
  return vars;
}
