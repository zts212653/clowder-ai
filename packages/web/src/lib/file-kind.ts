/**
 * F226: infer file kind / render mode from a file path.
 * Used by presentation surface (tear-off floating window) to decide how to render
 * the snapshotted file (image vs markdown vs raw code).
 */
// Aligned with server MIME_MAP (packages/api workspace.ts): /api/workspace/file/raw only serves
// files whose MIME starts with image/. avif/bmp are NOT in MIME_MAP and would render as broken
// images via the raw endpoint, so we keep them out here until the server adds support (云端 P2).
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico']);

export function inferFileKind(filePath: string): 'file' | 'image' | 'markdown' {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'md' || ext === 'mdx') return 'markdown';
  return 'file';
}

export function inferRenderMode(filePath: string): 'rendered' | 'raw' {
  return inferFileKind(filePath) === 'markdown' ? 'rendered' : 'raw';
}
