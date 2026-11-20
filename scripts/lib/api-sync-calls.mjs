import ts from 'typescript';
import { syncCallSource } from './api-sync-bindings.mjs';

const FORBIDDEN = new Map([
  ['process', new Set(['execSync', 'execFileSync', 'spawnSync'])],
  ['snapshot', new Set(['readUnixProcessSnapshotSync'])],
]);
// Exact separate-process entries; their launchers are cli-supervised-process,
// codex-login-driver, managed-runner and MemoryProcess respectively.
const CHILD_ENTRIES = new Set([
  'packages/api/src/utils/cli-supervisor.ts',
  'packages/api/src/config/codex-login-terminal-worker.ts',
  'packages/api/src/infrastructure/managed-runner-durable-worker.ts',
  'packages/api/src/domains/memory/memory-process-entry.ts',
]);

export function isApiProductionSource(file) {
  return /^packages\/api\/src\/.+\.(?:[cm]?[jt]sx?)$/u.test(file);
}

function callbackScope(node, source) {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  if (ts.isCallExpression(parent))
    return `callback:${parent.expression.getText(source)}:${parent.arguments.indexOf(node)}`;
  return node.name?.getText(source) ?? '<callback>';
}

function scopeComponent(node, source) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node))
    return node.name?.getText(source) ?? '<anonymous>';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return callbackScope(node, source);
}

function syntacticScope(node, source) {
  const parts = [];
  for (let at = node.parent; at && at !== source; at = at.parent) {
    const component = scopeComponent(at, source);
    if (component) parts.unshift(component);
  }
  return parts.join('/') || '<module>';
}

function calls(file, text) {
  const { source, reference } = syncCallSource(file, text);
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = reference(node.expression);
      if (FORBIDDEN.get(target?.module)?.has(target.member))
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          method: target.member,
          key: `${target.module}:${target.member}:${syntacticScope(node, source)}`,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/** Alias-aware, scope-local counts freeze existing debt. This detects the named
 * APIs, not arbitrary CPU work, SQLite, file I/O or dynamic/reassigned loaders. */
export function findNewApiSyncCalls(file, before, after) {
  if (!isApiProductionSource(file) || CHILD_ENTRIES.has(file)) return [];
  const remaining = new Map();
  for (const call of calls(file, before)) remaining.set(call.key, (remaining.get(call.key) ?? 0) + 1);
  return calls(file, after).filter((call) => {
    const count = remaining.get(call.key) ?? 0;
    if (!count) return true;
    remaining.set(call.key, count - 1);
    return false;
  });
}
