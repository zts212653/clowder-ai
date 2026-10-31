import { fileContentKind } from '@cat-cafe/shared';

/** Compatibility projection of the common content facts for existing surface descriptors. */
export function inferFileKind(filePath: string): 'file' | 'image' | 'markdown' {
  const kind = fileContentKind(filePath);
  return kind === 'image' || kind === 'markdown' ? kind : 'file';
}
export function inferRenderMode(filePath: string): 'rendered' | 'raw' {
  return inferFileKind(filePath) === 'markdown' ? 'rendered' : 'raw';
}
