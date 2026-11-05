import {
  type CollectiveMediaShareRef,
  type CollectiveRetainedMediaPage,
  collectiveArtifactProjectionSchema,
  collectiveRetainedMediaPageSchema,
  collectiveRetainedMediaRegistrationSchema,
  collectiveRetainedMediaShareSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

type Selected = CollectiveRetainedMediaPage['items'][number];
export async function readRetainedMediaPage(base: string, after?: string) {
  const response = await apiFetch(`${base}/retained-media${after ? `?after=${encodeURIComponent(after)}` : ''}`);
  if (!response.ok) throw new Error('暂时无法读取此 Café 的作品，请重试。');
  const parsed = collectiveRetainedMediaPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('作品列表尚未核对，请重新读取。');
  return parsed.data;
}

/** Persist the operation before sending. A lost response or remount retries the same owner publication. */
export async function shareRetainedMediaFromHost(
  base: string,
  ref: CollectiveMediaShareRef,
  selected: Selected,
  title: string,
  draftKey: string,
) {
  const input = {
    contentRef: selected.contentRef,
    ownerRevision: selected.ownerRevision,
    sourceEventId: ref.sourceEventId,
    title: title.trim(),
  };
  const receiptKey = `${draftKey}:operation:${JSON.stringify(input)}`;
  const operation = await prepareShareOperation(base, ref, selected, input, receiptKey);
  const response = await apiFetch(`${base}/share-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation),
  }).catch(() => {
    throw new Error('分享尚未确认，请重试同一次分享。');
  });
  if (!response.ok) {
    // A definite conflict committed no registration; another explicit click may prepare a fresh operation.
    // Keep every uncertain response frozen, including old pickers' UUID-only committed replay attempts.
    if (response.status === 409) localStorage.removeItem(receiptKey);
    throw new Error(shareErrorMessage(response.status));
  }
  const parsed = collectiveArtifactProjectionSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('分享回执尚未核对，请重试原分享。');
  const artifact = parsed.data;
  const expected = [
    ref.serviceInstanceId,
    ref.collectiveId,
    ref.sourceEventId,
    ref.channelId,
    selected.contentRef,
    selected.mediaType,
    selected.ownerRevision,
  ];
  const actual = [
    artifact.serviceInstanceId,
    artifact.collectiveId,
    artifact.sourceEventId,
    artifact.sourceLocation.channelId,
    artifact.contentRef,
    artifact.mediaType,
    artifact.versions.at(-1)?.ownerRevision,
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('分享回执与所选作品不一致。');
  return artifact;
}

async function prepareShareOperation(
  base: string,
  ref: CollectiveMediaShareRef,
  selected: Selected,
  input: { contentRef: string; ownerRevision: number; sourceEventId: string; title: string },
  receiptKey: string,
) {
  const saved = localStorage.getItem(receiptKey);
  if (saved) {
    // Earlier pickers persisted only their UUID. Preserve their exact request for committed replay.
    const operation = collectiveRetainedMediaShareSchema.parse(
      saved.startsWith('{') ? JSON.parse(saved) : { ...input, requestId: z.string().uuid().parse(saved) },
    );
    if (Object.entries(input).some(([key, value]) => operation[key as keyof typeof input] !== value))
      throw new Error('分享回执与所选作品不一致。');
    return operation;
  }
  const target = {
    contentRef: input.contentRef,
    sourceEventId: input.sourceEventId,
    mediaType: selected.mediaType,
  };
  const response = await apiFetch(`${base}/share-media/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(target),
  });
  if (!response.ok) throw new Error(shareErrorMessage(response.status));
  const registration = collectiveRetainedMediaRegistrationSchema.parse(await response.json());
  const expected = {
    ...target,
    serviceInstanceId: ref.serviceInstanceId,
    collectiveId: ref.collectiveId,
    connectionId: ref.connectionId,
  };
  if (Object.entries(expected).some(([key, value]) => registration[key as keyof typeof expected] !== value))
    throw new Error('分享回执与所选作品不一致。');
  const operation = collectiveRetainedMediaShareSchema.parse({
    ...input,
    requestId: crypto.randomUUID(),
    ...(registration.current
      ? {
          expectedRevision: registration.current.revision,
          expectedCustodyRevision: registration.current.custodyRevision,
          ...(registration.current.workId ? { workId: registration.current.workId } : {}),
        }
      : {}),
  });
  localStorage.setItem(receiptKey, JSON.stringify(operation));
  return operation;
}

function shareErrorMessage(status: number) {
  if (status === 409) return '作品已变化或已分享，请重新选择，或从资料库打开。';
  if (status === 403) return '这件作品现在不可分享，请重新读取列表。';
  return '分享尚未确认，请重试同一次分享。';
}
