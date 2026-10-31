import { readFileSync, statSync } from 'node:fs';
import ts from 'typescript';

// Syntactic TypeScript-AST helpers for the design-gate checkers. Per-file parsing
// and walking only: no type checker, no cross-file program, no reachability proof.
// (The static prover that used to live here was superseded by runtime journeys.)

const sourceCache = new Map();

function scriptKindFor(absolutePath) {
  if (/\.[jt]sx$/u.test(absolutePath)) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/u.test(absolutePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(absolutePath) {
  const stats = statSync(absolutePath);
  const cacheKey = `${absolutePath}:${stats.mtimeMs}:${stats.size}`;
  let parsed = sourceCache.get(cacheKey);
  if (!parsed) {
    parsed = ts.createSourceFile(
      absolutePath,
      readFileSync(absolutePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(absolutePath),
    );
    sourceCache.set(cacheKey, parsed);
  }
  return parsed;
}

export function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

export function isStringLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

export function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

export function lineOf(node) {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// Returns the string value of `name:` in an object literal, `null` when the property
// exists but is not a plain string literal, and `undefined` when it is absent.
export function propertyLiteral(objectLiteral, name) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return undefined;
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name) || isStringLike(property.name) ? property.name.text : undefined;
    if (key === name) return isStringLike(property.initializer) ? property.initializer.text : null;
  }
  return undefined;
}
