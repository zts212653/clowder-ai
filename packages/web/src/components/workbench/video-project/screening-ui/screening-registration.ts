import { immutableMediaSchema, type VideoProjectScreening } from '@cat-cafe/shared';
import { type ProjectSnapshot, projectPath, projectRequest } from '../api';

/** Freeze the source and input once; subsequent retries reuse this exact registration command. */
export async function createScreeningRegistration(input: {
  project: ProjectSnapshot;
  worktreeId: string | null;
  path: string;
  title: string;
  mapping: VideoProjectScreening['mapping'] | null;
}) {
  const { project, worktreeId, path, title, mapping } = input;
  if (!worktreeId) throw new Error('请先选择影片所在的工作区。');
  const source = await projectRequest('/api/video-projects/media-source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locator: { worktreeId, path } }),
  });
  if (
    !source ||
    typeof source !== 'object' ||
    !('revision' in source) ||
    !('locator' in source) ||
    !('media' in source)
  )
    throw new Error('当前文件没有可用的视频信息。');
  const media = immutableMediaSchema.parse(source.media);
  if (media.kind !== 'video') throw new Error('请选择一份 MP4 成片。');
  const operationId = crypto.randomUUID();
  return {
    expectedOwnerRevision: project.ownerRevision,
    operationId,
    id: operationId,
    title,
    input: { contentRef: project.contentRef, ownerRevision: project.ownerRevision, blobDigest: project.blobDigest },
    source: { locator: source.locator, expectedSourceRevision: source.revision },
    mapping: mapping ?? {
      segments: [],
      frame: {
        displayWidth: media.width,
        displayHeight: media.height,
        canvasWidth: project.document.timeline.width,
        canvasHeight: project.document.timeline.height,
        rotation: 0,
      },
    },
    refs: [`workspace:${worktreeId}:${path}@${source.revision}`],
  };
}
export type ScreeningRegistrationCommand = Awaited<ReturnType<typeof createScreeningRegistration>>;

/** A lost response is successful only when the owner's operation receipt confirms the append. */
export async function confirmScreeningRegistration(contentRef: string, command: ScreeningRegistrationCommand) {
  try {
    await projectRequest(`${projectPath(contentRef)}/screenings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
  } catch (original) {
    const observed = await projectRequest(
      `${projectPath(contentRef)}/operations/${encodeURIComponent(command.operationId)}`,
    );
    if (!observed || typeof observed !== 'object' || !('receipt' in observed) || !observed.receipt) throw original;
  }
}
