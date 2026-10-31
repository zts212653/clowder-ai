import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';
import { getDefaultUploadDir } from '../../../../../../utils/upload-paths.js';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Headless accepts text; view_file delivers image/PDF/audio/video bytes as native tool parts. */
export function prepareAgyNativeInput(
  prompt: string,
  contentBlocks: readonly MessageContent[] | undefined,
  workspaceRoot: string,
  uploadDir?: string,
): { prompt: string; accessDirectories: string[]; hasAttachments: boolean } {
  const attachments = contentBlocks?.filter((block) => block.type === 'image' || block.type === 'file') ?? [];
  if (!attachments.length) return { prompt, accessDirectories: [], hasAttachments: false };
  const directories = new Set<string>();
  const references = attachments.map((block) => {
    if (/^https?:\/\//.test(block.url)) return `${block.type} URL: ${JSON.stringify(block.url)}`;
    const uploaded = block.url.startsWith('/uploads/');
    const root = uploaded ? realpathSync(getDefaultUploadDir(uploadDir ?? process.env.UPLOAD_DIR)) : workspaceRoot;
    const logical = uploaded ? resolve(root, block.url.slice('/uploads/'.length)) : resolve(block.url);
    if (!within(root, logical)) throw new Error('Native attachment path escapes its upload or workspace directory');
    const path = realpathSync(logical);
    if (!within(root, path) || !statSync(path).isFile()) throw new Error('Native attachment is not an in-scope file');
    directories.add(dirname(path));
    return `${block.type} file for view_file: ${JSON.stringify(path)}`;
  });
  return {
    prompt: `${prompt}\n\n[User attachments — read their contents before answering]\n${references.join('\n')}`,
    accessDirectories: [...directories].filter((directory) => directory !== workspaceRoot),
    hasAttachments: true,
  };
}
