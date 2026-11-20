import { deploymentDefaults } from '@cat-cafe/shared';
import { isPathAllowed } from '../utils/path-validator.js';
import { authorizeInvocationTool, invocationFetch, resolveInvocationEnv } from './invocation-auth.js';

export async function handlePublishedFileSlice(
  input: {
    path: string;
    startLine: number;
    endLine?: number;
    charOffset?: number;
    expectedRevision?: string;
  },
  authorityToolName = 'cat_cafe_read_file_slice',
) {
  const match = /^cat-cafe:\/\/published\/([a-f0-9]{16})\/([^/?#]+)$/u.exec(input.path);
  if (!match) return failure('Invalid published source reference');
  let anchor: string;
  try {
    anchor = decodeURIComponent(match[2]);
  } catch {
    return failure('Invalid published source reference encoding');
  }
  await authorizeInvocationTool(authorityToolName);
  const userId = resolveInvocationEnv('CAT_CAFE_USER_ID')?.trim();
  const base = resolveInvocationEnv('CAT_CAFE_API_URL') ?? deploymentDefaults.apiBaseUrl;
  const params = new URLSearchParams({
    anchor,
    sourceHash: match[1],
    startLine: String(input.startLine),
    endLine: String(input.endLine ?? input.startLine + 119),
    charOffset: String(input.charOffset ?? 0),
  });
  try {
    const response = await invocationFetch(`${base}/api/evidence/published-source?${params}`, {
      headers: userId ? { 'x-cat-cafe-user': userId } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return failure(`Published source unavailable (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    const data = (await response.json()) as {
      text: string;
      sourceHash: string;
      sourceVersion: string;
      sourcePath: string;
      authorizationPath: string;
      next?: { startLine: number; charOffset: number };
    };
    if (!data.authorizationPath || !isPathAllowed(data.authorizationPath))
      return failure('Access denied: published source is not within allowed directories');
    await authorizeInvocationTool(authorityToolName);
    if (input.expectedRevision !== undefined && input.expectedRevision !== data.sourceVersion)
      return failure('source_revision_changed; restart from the current published source');
    const next = data.next
      ? `\nSource continues; next slice: cat_cafe_read_file_slice(${JSON.stringify({ path: input.path, ...data.next })})`
      : '';
    const text = `Versioned source: ${data.sourcePath} · hash:${data.sourceHash} · version:${data.sourceVersion}\n${data.text}${next}`;
    return {
      structuredContent: {
        text,
        version: data.sourceVersion,
        complete: !data.next,
        ...(data.next
          ? {
              nextRef: {
                kind: 'file',
                path: input.path,
                ...data.next,
                endLine: data.next.startLine + (input.endLine === undefined ? 119 : input.endLine - input.startLine),
                expectedRevision: data.sourceVersion,
              },
            }
          : {}),
      },
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    };
  } catch {
    return failure('Published source read failed; retry the original reference after checking source availability');
  }
}
function failure(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
