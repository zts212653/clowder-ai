import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { escapeRegExp, insideRepo, nonEmptyString } from './shared.mjs';

function normalizeIdentity(filePath) {
  const withoutExtension = filePath.slice(0, filePath.length - extname(filePath).length);
  return withoutExtension.endsWith(`${sep}index`) ? withoutExtension.slice(0, -`${sep}index`.length) : withoutExtension;
}

export function resolveImportTarget({ repoRoot, parentPath, specifier }) {
  let basePath;
  if (specifier.startsWith('.')) {
    basePath = resolve(dirname(resolve(repoRoot, parentPath)), specifier);
  } else if (specifier.startsWith('@/')) {
    basePath = resolve(repoRoot, 'packages/web/src', specifier.slice(2));
  } else {
    return undefined;
  }

  // NodeNext source imports spell the emitted extension (`./Surface.js`) while
  // the checked-in implementation remains TypeScript (`Surface.tsx`). Keep the
  // literal file first, then resolve that standard source form without making
  // an arbitrary import look like a mount edge.
  const sourceBasePath = extname(basePath) === '.js' ? basePath.slice(0, -'.js'.length) : basePath;
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    resolve(basePath, 'index.ts'),
    resolve(basePath, 'index.tsx'),
    resolve(basePath, 'index.js'),
    resolve(basePath, 'index.jsx'),
    `${sourceBasePath}.ts`,
    `${sourceBasePath}.tsx`,
    `${sourceBasePath}.jsx`,
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function importedAndMounted({ repoRoot, parent, child, errors, label }) {
  const parentAbsolutePath = insideRepo(repoRoot, parent?.path);
  const childAbsolutePath = insideRepo(repoRoot, child?.path);
  if (!parentAbsolutePath || !existsSync(parentAbsolutePath)) {
    errors.push(`${label}: parent path does not exist: ${parent?.path ?? '<missing>'}`);
    return;
  }
  if (!childAbsolutePath || !existsSync(childAbsolutePath)) {
    errors.push(`${label}: child path does not exist: ${child?.path ?? '<missing>'}`);
    return;
  }
  if (!nonEmptyString(parent?.export) || !nonEmptyString(child?.export)) {
    errors.push(`${label}: parent and child exports are required`);
    return;
  }

  const parentSource = readFileSync(parentAbsolutePath, 'utf8');
  const childIdentity = normalizeIdentity(childAbsolutePath);
  const importPattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gu;
  let importsChild = false;
  let importMatch = importPattern.exec(parentSource);
  while (importMatch) {
    const [, importClause, specifier] = importMatch;
    const target = resolveImportTarget({ repoRoot, parentPath: parent.path, specifier });
    if (
      target &&
      normalizeIdentity(target) === childIdentity &&
      new RegExp(`\\b${escapeRegExp(child.export)}\\b`, 'u').test(importClause)
    ) {
      importsChild = true;
      break;
    }
    importMatch = importPattern.exec(parentSource);
  }

  if (!importsChild) {
    errors.push(`${label}: ${parent.export} must import ${child.export} from ${child.path}`);
  }
  if (!new RegExp(`<\\s*${escapeRegExp(child.export)}(?:\\s|/|>)`, 'u').test(parentSource)) {
    errors.push(`${label}: ${parent.export} must mount <${child.export}>`);
  }
}
