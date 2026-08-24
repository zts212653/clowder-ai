#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const STORE_PATH = 'packages/web/src/stores/sidebarProjectionStore.ts';
const API_PROJECTION_PATH = 'packages/api/src/routes/sidebar-presence-projection.ts';
const RENDER_PATHS = new Set([
  'packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx',
  'packages/web/src/components/ThreadSidebar/ThreadItem.tsx',
  'packages/web/src/components/ThreadSidebar/thread-utils.ts',
  'packages/web/src/components/ThreadSidebar/SectionGroup.tsx',
  'packages/web/src/components/ThreadSidebar/VirtualThreadList.tsx',
  'packages/web/src/components/ThreadCatStatus.tsx',
]);
const DTO_FORBIDDEN = new Set([
  'pinnedAt',
  'favoritedAt',
  'connectorHubState',
  'activeInvocations',
  'catInvocations',
  'messages',
  'queue',
  'intentMode',
  'viewport',
]);

function sourceKind(path) {
  return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function listProductionSources(root) {
  const base = resolve(root, 'packages/web/src');
  if (!existsSync(base)) return [];
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.[^.]+$/.test(entry.name)) continue;
      files.push(path);
    }
  };
  walk(base);
  return files;
}

function propertyName(node) {
  if (!node?.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function hasAncestorProperty(node, expected) {
  let current = node.parent;
  while (current) {
    if ((ts.isPropertyAssignment(current) || ts.isMethodDeclaration(current)) && propertyName(current) === expected) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function objectHasRows(object) {
  return object.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property) === 'rows',
  );
}

function expressionWritesRows(node) {
  if (ts.isObjectLiteralExpression(node) && objectHasRows(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && expressionWritesRows(child)) found = true;
  });
  return found;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function nodeContains(root, candidate) {
  return candidate.pos >= root.pos && candidate.end <= root.end;
}

function declarationName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
    return propertyName(node) ?? (ts.isIdentifier(node.name) ? node.name.text : '');
  }
  return '';
}

function isWorkingElapsedLastActiveAt(node) {
  let current = node.parent;
  while (current) {
    const name = declarationName(current).toLowerCase();
    if (name && /working/.test(name) && /elapsed|duration/.test(name)) return true;
    if (
      ts.isConditionalExpression(current) &&
      nodeContains(current.whenTrue, node) &&
      /working/.test(current.condition.getText().toLowerCase())
    ) {
      return true;
    }
    if (
      ts.isIfStatement(current) &&
      nodeContains(current.thenStatement, node) &&
      /working/.test(current.expression.getText().toLowerCase())
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function inspectSource(root, absolutePath, errors, counters) {
  const path = relative(root, absolutePath).replaceAll('\\', '/');
  const text = readFileSync(absolutePath, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceKind(path));

  if (RENDER_PATHS.has(path)) {
    if (/useThreadLiveness|projectTerminalLiveness/.test(text)) {
      errors.push(`${path}: Sidebar render tree imports or calls legacy liveness`);
    }
    if (/mergeLiveActivityIntoThreads|reconcileActiveThreadOrder/.test(text)) {
      errors.push(`${path}: Sidebar sort still depends on legacy runtime activity`);
    }
    if (/\bthreadStates\b/.test(text)) {
      errors.push(`${path}: Sidebar render tree reads legacy threadStates`);
    }
    if (
      /\bthreads\s*:\s*(?:s|state)\.threads\b|useChatStore\.getState\(\)\.threads\b|useChatStore\([^\n]*=>[^\n]*\.threads\b/.test(
        text,
      )
    ) {
      errors.push(`${path}: Sidebar render tree reads legacy chatStore.threads`);
    }
    if (/\blastActivity\b/.test(text)) {
      errors.push(`${path}: Sidebar render tree reads legacy lastActivity`);
    }
    if (
      /import\s+(?:type\s+)?\{[^}]*\bThread\b[^}]*\}\s+from\s+['"]@\/stores\/(?:chatStore|chat-types)['"]/.test(text)
    ) {
      errors.push(`${path}: Sidebar render tree imports the wide legacy Thread DTO`);
    }
  }

  const visit = (node) => {
    if (
      RENDER_PATHS.has(path) &&
      ts.isIdentifier(node) &&
      node.text === 'lastActiveAt' &&
      isWorkingElapsedLastActiveAt(node)
    ) {
      errors.push(`${path}:${lineOf(source, node)} working elapsed reads C7 lastActiveAt`);
    }

    if (ts.isInterfaceDeclaration(node) && node.name.text === 'SidebarSnapshotRow') {
      counters.dtoSeen = true;
      for (const member of node.members) {
        const name = propertyName(member);
        if (name && DTO_FORBIDDEN.has(name))
          errors.push(`${path}:${lineOf(source, member)} DTO contains forbidden ${name}`);
      }
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [first] = node.arguments;
      if (expressionWritesRows(first)) {
        const isStoreSetter = path === STORE_PATH && ts.isIdentifier(node.expression) && node.expression.text === 'set';
        const isDirectSetState =
          ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setState';
        if (isStoreSetter || isDirectSetState) {
          counters.rowWrites += 1;
          if (!hasAncestorProperty(node, 'applySidebarSnapshot')) {
            errors.push(`${path}:${lineOf(source, node)} canonical rows written outside applySidebarSnapshot`);
          }
        }
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === 'saveSidebarSnapshot') {
        counters.persistenceCalls += 1;
        if (path !== STORE_PATH || !hasAncestorProperty(node, 'applySidebarSnapshot')) {
          errors.push(`${path}:${lineOf(source, node)} Sidebar persistence called outside canonical apply`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function inspectApiProjection(root, errors) {
  const absolutePath = resolve(root, API_PROJECTION_PATH);
  if (!existsSync(absolutePath)) {
    errors.push(`${API_PROJECTION_PATH}: canonical presence projection not found`);
    return;
  }
  const text = readFileSync(absolutePath, 'utf8');
  const source = ts.createSourceFile(API_PROJECTION_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (imported === 'ThreadParticipantActivity') {
        errors.push(`${API_PROJECTION_PATH}:${lineOf(source, node)} conversation activity imported as presence truth`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'getParticipantsWithActivityBatch') {
      errors.push(`${API_PROJECTION_PATH}:${lineOf(source, node)} conversation activity read as presence truth`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export function checkSidebarProjectionBoundary(root) {
  const errors = [];
  const counters = { rowWrites: 0, persistenceCalls: 0, dtoSeen: false };
  for (const path of listProductionSources(root)) inspectSource(root, path, errors, counters);
  inspectApiProjection(root, errors);
  if (!counters.dtoSeen) errors.push(`${STORE_PATH}: SidebarSnapshotRow DTO not found`);
  if (counters.rowWrites !== 1) {
    errors.push(`canonical rows must have exactly one writer; found ${counters.rowWrites}`);
  }
  if (counters.persistenceCalls !== 1) {
    errors.push(`Sidebar snapshot persistence must have exactly one call edge; found ${counters.persistenceCalls}`);
  }
  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const errors = checkSidebarProjectionBoundary(process.cwd());
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('F297 Sidebar projection boundary: OK');
  }
}
