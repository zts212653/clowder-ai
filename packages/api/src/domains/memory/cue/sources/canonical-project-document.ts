import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const MAX_CANONICAL_PROJECT_DOCUMENT_CONTENT_CHARS = 4_000;

export interface CanonicalProjectDocument {
  readonly content: string;
  readonly revision: string;
  readonly sourcePath: string;
}

export interface CanonicalProjectDocumentWindow {
  readonly content: string;
  readonly contentTruncated: boolean;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export async function readCanonicalProjectDocument(
  projectRoot: string,
  sourcePath: string | undefined,
): Promise<CanonicalProjectDocument | null> {
  if (!sourcePath || isAbsolute(sourcePath) || sourcePath.includes('\\')) return null;
  const root = resolve(projectRoot);
  const candidate = resolve(root, sourcePath);
  if (!isContained(root, candidate)) return null;
  try {
    const physicalRoot = await realpath(root);
    const physicalCandidate = await realpath(candidate);
    if (!isContained(physicalRoot, physicalCandidate)) return null;
    const content = await readFile(physicalCandidate, 'utf8');
    const revision = `sha256:${createHash('sha256').update(sourcePath).update('\0').update(content).digest('hex')}`;
    return { content, revision, sourcePath };
  } catch {
    return null;
  }
}

export function canonicalProjectDocumentWindow(content: string): CanonicalProjectDocumentWindow {
  return {
    content: content.slice(0, MAX_CANONICAL_PROJECT_DOCUMENT_CONTENT_CHARS),
    contentTruncated: content.length > MAX_CANONICAL_PROJECT_DOCUMENT_CONTENT_CHARS,
  };
}
