import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { type MemoryCueDocumentWindowRequest, memoryCueDocumentWindowRequestSchema } from '@cat-cafe/shared';

export const MAX_CANONICAL_PROJECT_DOCUMENT_CONTENT_CHARS = 4_000;

export interface CanonicalProjectDocument {
  readonly content: string;
  readonly revision: string;
  readonly sourcePath: string;
}

export interface CanonicalProjectDocumentWindow {
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly contentRange: { start: number; end: number; total: number; unit: 'utf16_code_unit' };
  readonly nextOffset: number | null;
  readonly location: { status: 'start' | 'offset' | 'matched' | 'not_found'; matchOffset?: number };
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

export function canonicalProjectDocumentWindow(
  content: string,
  request: MemoryCueDocumentWindowRequest = {},
): CanonicalProjectDocumentWindow {
  const window = memoryCueDocumentWindowRequestSchema.parse(request);
  let start = Math.min(window.offset ?? 0, content.length);
  let location: CanonicalProjectDocumentWindow['location'] = {
    status: window.offset === undefined ? 'start' : 'offset',
  };
  if (window.query !== undefined) {
    const literal = window.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(literal, 'iu').exec(content);
    if (match) {
      start = Math.max(0, match.index - 200);
      location = { status: 'matched', matchOffset: match.index };
    } else location = { status: 'not_found' };
  }
  const end = Math.min(start + MAX_CANONICAL_PROJECT_DOCUMENT_CONTENT_CHARS, content.length);
  return {
    content: content.slice(start, end),
    contentTruncated: start > 0 || end < content.length,
    contentRange: { start, end, total: content.length, unit: 'utf16_code_unit' },
    nextOffset: end < content.length ? end : null,
    location,
  };
}
