import ts from 'typescript';

function nameOf(expression) {
  return ts.isIdentifier(expression) || ts.isStringLiteral(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : undefined;
}

function callableName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return nameOf(node.name);
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent))
    return nameOf(node.parent.name);
  return undefined;
}

function ownerPath(node) {
  const parts = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    const name = callableName(parent) ?? (ts.isClassDeclaration(parent) && parent.name ? parent.name.text : undefined);
    if (name) parts.unshift(name);
  }
  return parts.join('.') || '<module>';
}

function assignedHandle(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return nameOf(parent.name);
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return nameOf(parent.left);
    if (ts.isFunctionLike(parent)) return undefined;
  }
  return undefined;
}

function timeoutRecurs(node) {
  let owner;
  for (let parent = node.parent; parent && !owner; parent = parent.parent) owner = callableName(parent);
  const callback = node.arguments[0];
  if (!owner || !callback) return false;
  if (nameOf(callback) === owner) return true;
  let recurs = false;
  function visit(child) {
    if (ts.isCallExpression(child) && nameOf(child.expression) === owner) recurs = true;
    ts.forEachChild(child, visit);
  }
  visit(callback);
  return recurs;
}

function scopeOf(node) {
  for (let parent = node; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return parent;
  return undefined;
}

function timerKind(expression, aliases) {
  const name = nameOf(expression);
  if (name === 'setInterval' || name === 'setTimeout') return name;
  for (let scope = scopeOf(expression); name && scope; scope = scopeOf(scope.parent)) {
    const kind = aliases.get(scope)?.get(name);
    if (kind) return kind;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    return timerKind(expression.right, aliases) ?? timerKind(expression.left, aliases);
  return undefined;
}

function property(object, name) {
  return object.properties.find((entry) => ts.isPropertyAssignment(entry) && nameOf(entry.name) === name);
}

function triggerBranches(expression) {
  if (!expression) return [];
  if (ts.isObjectLiteralExpression(expression)) return [expression];
  if (ts.isConditionalExpression(expression))
    return [...triggerBranches(expression.whenTrue), ...triggerBranches(expression.whenFalse)];
  return [];
}

function taskTriggers(node) {
  if (!ts.isObjectLiteralExpression(node)) return [];
  return ['trigger', 'defaultTrigger'].flatMap((name) =>
    triggerBranches(property(node, name)?.initializer).flatMap((trigger) => {
      const kind = property(trigger, 'type')?.initializer;
      return kind && ts.isStringLiteral(kind) && ['interval', 'cron'].includes(kind.text)
        ? [{ trigger, suffix: `${name}:${kind.text}` }]
        : [];
    }),
  );
}

function timerImports(node) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return [];
  if (!/^(?:node:)?timers(?:\/promises)?$/.test(node.moduleSpecifier.text)) return [];
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.flatMap((entry) => {
    const kind = (entry.propertyName ?? entry.name).text;
    return ['setInterval', 'setTimeout'].includes(kind) ? [{ name: entry.name.text, kind }] : [];
  });
}

/** Discover actual scheduling expressions, including injected timer aliases and TaskSpec triggers. */
export function discoverRecoveryLoopSites(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map();
  function addAlias(scope, name, kind) {
    if (!aliases.has(scope)) aliases.set(scope, new Map());
    aliases.get(scope).set(name, kind);
  }
  function readAliases(node) {
    for (const { name, kind } of timerImports(node)) addAlias(source, name, kind);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const kind = timerKind(node.initializer, aliases);
      if (kind && ts.isIdentifier(node.name)) addAlias(scopeOf(node), node.name.text, kind);
    }
    ts.forEachChild(node, readAliases);
  }
  readAliases(source);
  const sites = [];
  const seen = new Map();
  function record(node, suffix, kind) {
    const stem = `${file}#${ownerPath(node)}.${suffix}`;
    const count = (seen.get(stem) ?? 0) + 1;
    seen.set(stem, count);
    sites.push({
      key: count === 1 ? stem : `${stem}[${count}]`,
      file,
      kind,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (nameOf(node.expression) === 'registerRecoveryLoop') {
        const definition = node.arguments[0];
        const id =
          definition && ts.isObjectLiteralExpression(definition)
            ? definition.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'id')?.initializer
            : undefined;
        record(node, `recovery:${id && ts.isStringLiteralLike(id) ? id.text : 'dynamic'}`, 'recovery-loop');
      }
      const kind = timerKind(node.expression, aliases);
      if (kind === 'setInterval' || (kind === 'setTimeout' && timeoutRecurs(node)))
        record(node, assignedHandle(node) ?? nameOf(node.expression), kind);
    }
    for (const { trigger, suffix } of taskTriggers(node)) record(trigger, suffix, 'task-spec');
    ts.forEachChild(node, visit);
  }
  visit(source);
  return sites;
}
