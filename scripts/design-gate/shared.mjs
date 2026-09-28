import { relative, resolve, sep } from 'node:path';

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function asStringList(value) {
  if (Array.isArray(value)) return value.filter(nonEmptyString);
  return nonEmptyString(value) ? [value] : [];
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function insideRepo(repoRoot, relativePath) {
  if (!nonEmptyString(relativePath)) return undefined;
  const absolutePath = resolve(repoRoot, relativePath);
  const fromRoot = relative(repoRoot, absolutePath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined;
  return absolutePath;
}
