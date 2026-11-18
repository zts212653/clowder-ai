import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const pictographs = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const parse = (file, text) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
const nameOf = (node) =>
  node?.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
const properties = (node) =>
  new Map(
    node.properties.flatMap((property) =>
      ts.isPropertyAssignment(property)
        ? [[nameOf(property), property.initializer]]
        : ts.isShorthandPropertyAssignment(property)
          ? [[property.name.text, property.name]]
          : [],
    ),
  );
const literal = (node, constants) =>
  node && ts.isStringLiteralLike(node)
    ? node.text
    : node && ts.isIdentifier(node)
      ? constants?.(node)?.value
      : undefined;
const iconVariants = (node, constants) =>
  !node
    ? []
    : ts.isConditionalExpression(node)
      ? [...iconVariants(node.whenTrue, constants), ...iconVariants(node.whenFalse, constants)]
      : [literal(node, constants)].filter(Boolean);
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Only definitions backed by an actual renderer suppress a legacy source.icon fallback. */
export function registeredConnectorSvgs(root) {
  const renderer = parse(
    'ConnectorIcon.tsx',
    readFileSync(join(root, 'packages/web/src/components/icons/ConnectorIcon.tsx'), 'utf8'),
  );
  const rendered = new Set();
  walk(renderer, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(renderer) === 'SVG_ICON_MAP' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) rendered.add(nameOf(property));
    }
  });
  const definitions = parse(
    'connector-definitions.ts',
    readFileSync(join(root, 'packages/shared/src/types/connector-definitions.ts'), 'utf8'),
  );
  const registered = new Map();
  walk(definitions, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const props = properties(node);
    const id = literal(props.get('id'));
    const icon = props.get('icon');
    if (!id || !icon || !ts.isObjectLiteralExpression(icon)) return;
    const spec = properties(icon);
    const iconId = literal(spec.get('iconId'));
    if (literal(spec.get('type')) === 'svg' && rendered.has(iconId)) registered.set(id, iconId);
  });
  return registered;
}

/** Resolve constants by TypeScript lexical binding, never by a file-wide name exclusion. */
function moduleStringBindings(ast, text) {
  const file = ast.fileName;
  const sameFile = (name) => resolve(name) === file;
  const host = {
    getSourceFile: (name) => (sameFile(name) ? ast : undefined),
    getDefaultLibFileName: () => '',
    writeFile() {},
    getCurrentDirectory: () => process.cwd(),
    getDirectories: () => [],
    fileExists: sameFile,
    readFile: (name) => (sameFile(name) ? text : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const checker = ts.createProgram([file], { noLib: true, noResolve: true }, host).getTypeChecker();
  const constants = new Map();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = literal(declaration.initializer);
      if (!ts.isIdentifier(declaration.name) || value === undefined) continue;
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (!symbol) continue;
      const start = ast.getLineAndCharacterOfPosition(declaration.getStart(ast)).line + 1;
      const end = ast.getLineAndCharacterOfPosition(declaration.end).line + 1;
      constants.set(symbol, { value, lines: Array.from({ length: end - start + 1 }, (_, i) => start + i) });
    }
  }
  return (node) =>
    constants.get(
      ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node),
    );
}

/** AST inventory of message-source icon literals; arbitrary backend text is not an icon. */
export function messageSourceIcons(file, text, registeredSvgs) {
  const ast = parse(resolve(file), text);
  const constants = moduleStringBindings(ast, text);
  const icons = [];
  walk(ast, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const props = properties(node);
    const connectorNode = props.get('connector');
    const iconNode = props.get('icon');
    const variants = iconVariants(iconNode, constants).filter((value) => value.match(pictographs));
    const icon = variants.join(' / ');
    if (!connectorNode || !variants.length) return;
    const connector = literal(connectorNode, constants);
    const referencedLines = new Set();
    for (const root of [connectorNode, iconNode])
      walk(root, (part) => {
        if (ts.isIdentifier(part)) for (const line of constants(part)?.lines ?? []) referencedLines.add(line);
      });
    const line = ast.getLineAndCharacterOfPosition(iconNode.getStart(ast)).line + 1;
    const endLine = ast.getLineAndCharacterOfPosition(iconNode.end).line + 1;
    icons.push({
      file,
      line,
      endLine,
      connector: connector ?? connectorNode.getText(ast),
      icon,
      connectorLine: ast.getLineAndCharacterOfPosition(connectorNode.getStart(ast)).line + 1,
      referencedLines: [...referencedLines],
      svg: connector ? registeredSvgs.get(connector) : undefined,
      pictographs: [...new Set(icon.match(pictographs))],
      text: `connector: ${connector ?? connectorNode.getText(ast)}, icon: ${JSON.stringify(icon)}`,
    });
  });
  return icons;
}

/** Added icon/connector lines only: existing unrelated sources stay inventoried legacy debt. */
export function findAddedMessageSourcePictographs(
  diff,
  { root, readSource = (file) => readFileSync(join(root, file), 'utf8'), registeredSvgs } = {},
) {
  const changed = new Map();
  let file;
  let line;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : undefined;
      line = undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (line === undefined || raw.startsWith('-') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+') && /^packages\/api\/src\/.+\.ts$/u.test(file ?? '') && !file.endsWith('.test.ts')) {
      if (!changed.has(file)) changed.set(file, new Set());
      changed.get(file).add(line);
    }
    line++;
  }
  if (!changed.size) return [];
  const registry = registeredSvgs ?? registeredConnectorSvgs(root);
  return [...changed].flatMap(([path, lines]) =>
    messageSourceIcons(path, readSource(path), registry).filter(
      (icon) =>
        !icon.svg &&
        (lines.has(icon.connectorLine) ||
          icon.referencedLines.some((line) => lines.has(line)) ||
          [...lines].some((line) => line >= icon.line && line <= icon.endLine)),
    ),
  );
}
