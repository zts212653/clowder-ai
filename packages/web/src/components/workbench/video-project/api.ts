import { videoProjectDocumentSchema, videoProjectScreeningSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const snapshotSchema = z
  .object({
    contentRef: z.string(),
    ownerRevision: z.number().int().positive(),
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    document: videoProjectDocumentSchema,
  })
  .strict();
export type ProjectSnapshot = z.infer<typeof snapshotSchema>;
export type ScreeningDescriptor = { screening: z.infer<typeof videoProjectScreeningSchema>; mediaUrl: string };
export const projectPath = (contentRef: string) => `/api/video-projects/${encodeURIComponent(contentRef)}`;

export async function projectRequest(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const failure = body && typeof body === 'object' && 'error' in body ? body.error : null;
    const code =
      typeof failure === 'string'
        ? failure
        : failure && typeof failure === 'object' && 'code' in failure
          ? String(failure.code)
          : String(response.status);
    const message: Record<string, string> = {
      access_denied: '当前身份无法查看或修改这份项目。',
      not_found: '这份项目或素材暂时找不到。',
      media_missing: '登记的成片文件已不在原处。',
      source_changed: '原消息或素材已变化，请重新核对后再操作。',
      revision_conflict: '项目已有新的修改，请刷新后重试。',
      invalid_request: '提交的信息不完整，请检查后重试。',
    };
    throw new Error(message[code] ?? '审片项目暂时不可用，请稍后重试。');
  }
  return response.json() as Promise<unknown>;
}
export async function loadProject(contentRef: string, signal: AbortSignal, ownerRevision?: number) {
  const snapshot = snapshotSchema.parse(
    await projectRequest(`${projectPath(contentRef)}${ownerRevision ? `?ownerRevision=${ownerRevision}` : ''}`, {
      signal,
    }),
  );
  if (snapshot.contentRef !== contentRef || (ownerRevision && snapshot.ownerRevision !== ownerRevision))
    throw new Error('项目版本不匹配，请重新打开。');
  return snapshot;
}
export async function listProjects(signal: AbortSignal) {
  return z.object({ projects: z.array(snapshotSchema) }).parse(await projectRequest('/api/video-projects', { signal }))
    .projects;
}
export async function loadScreening(
  contentRef: string,
  screeningId: string,
  signal: AbortSignal,
): Promise<ScreeningDescriptor> {
  const path = `${projectPath(contentRef)}/screenings/${encodeURIComponent(screeningId)}`;
  const result = z
    .object({ screening: videoProjectScreeningSchema, mediaUrl: z.string() })
    .parse(await projectRequest(path, { signal }));
  if (
    result.screening.id !== screeningId ||
    result.screening.input.contentRef !== contentRef ||
    result.mediaUrl !== `${path}/media`
  )
    throw new Error('成片引用不匹配，请重新打开。');
  return result;
}
