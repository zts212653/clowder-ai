import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';
import { getDefaultUploadDir } from '../../../../../../utils/upload-paths.js';
import { NATIVE_AUTH_CONTINUATION_PROMPT } from '../../invocation/native-auth-continuation.js';

export type AgyNativeMessageInjectionDecision =
  | 'adapter_native_file_attachment_references'
  | 'agy_native_dynamic_l0'
  | 'agy_native_dynamic_l0_with_attachment_references';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function formatAgyNativeTurnPrompt(
  prompt: string,
  volatileL0Context?: string,
): { prompt: string; hasDynamicL0: boolean } {
  if (!volatileL0Context) return { prompt, hasDynamicL0: false };
  if (prompt === NATIVE_AUTH_CONTINUATION_PROMPT) return { prompt, hasDynamicL0: false };
  if (prompt.trim() === '/compact') return { prompt, hasDynamicL0: false };
  const trimmed = volatileL0Context.trim();
  if (!trimmed) return { prompt, hasDynamicL0: false };
  const dynamicBlock = [
    '<agy-turn-dynamic-l0>',
    '以下为本轮实时生效的主人画像与队友名册快照（若与本会话早期轮次中的同名快照不同，一律以本轮最新快照为准）：',
    '',
    trimmed,
    '</agy-turn-dynamic-l0>',
  ].join('\n');
  return {
    prompt: prompt ? `${dynamicBlock}\n\n${prompt}` : dynamicBlock,
    hasDynamicL0: true,
  };
}

/** Headless accepts text; the native file reader delivers media bytes as tool parts. */
export function prepareAgyNativeInput(
  prompt: string,
  contentBlocks: readonly MessageContent[] | undefined,
  workspaceRoot: string,
  uploadDir?: string,
  volatileL0Context?: string,
): {
  prompt: string;
  accessDirectories: string[];
  hasAttachments: boolean;
  injectionDecision?: AgyNativeMessageInjectionDecision;
} {
  const { prompt: promptWithDynamicL0, hasDynamicL0 } = formatAgyNativeTurnPrompt(prompt, volatileL0Context);
  const attachments = contentBlocks?.filter((block) => block.type === 'image' || block.type === 'file') ?? [];
  if (!attachments.length) {
    return {
      prompt: promptWithDynamicL0,
      accessDirectories: [],
      hasAttachments: false,
      ...(hasDynamicL0 ? { injectionDecision: 'agy_native_dynamic_l0' as const } : {}),
    };
  }
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
    return `${block.type} file for read_file (view_file on older CLI): ${JSON.stringify(path)}`;
  });
  return {
    prompt: `${promptWithDynamicL0}\n\n[User attachments — read their contents before answering]\n${references.join('\n')}`,
    accessDirectories: [...directories].filter((directory) => directory !== workspaceRoot),
    hasAttachments: true,
    injectionDecision: hasDynamicL0
      ? 'agy_native_dynamic_l0_with_attachment_references'
      : 'adapter_native_file_attachment_references',
  };
}
