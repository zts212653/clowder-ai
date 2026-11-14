import {
  type WorkCoverChoice,
  type WorkCoverPick,
  type WorkCoverView,
  type WorkReference,
  workCoverPickSchema,
  workCoverViewSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

/** Window event: a cover of this exact version changed here; the server notice reaches other surfaces. */
export const WORK_COVER_CHANGED_EVENT = 'cat-cafe:work-cover-changed';
export const WORK_PROJECTION_EVENT = 'cat-cafe:entrusted-work-projection-invalidated';

export const COVER_CARD_RATIO = 16 / 10;
const MAX_CROP = 0.1;

/**
 * Fill the 16:10 card only when the actual picture loses at most a tenth to cropping; otherwise show
 * the whole picture over a blurred copy of itself. Decided from real pixels, never a portrait/landscape label.
 */
export function coverFit(width: number, height: number, card = COVER_CARD_RATIO): 'fill' | 'contain' {
  if (!(width > 0 && height > 0 && card > 0)) return 'contain';
  const ratio = width / height;
  return 1 - Math.min(ratio / card, card / ratio) <= MAX_CROP + 1e-9 ? 'fill' : 'contain';
}

export function coverShape(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  if (Math.abs(width - height) / Math.max(width, height) < 0.04) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

/** Small integer label such as 16:9 or 3:4, from actual pixels. */
export function coverRatioLabel(width: number, height: number) {
  const known: [number, number][] = [
    [16, 9],
    [16, 10],
    [4, 3],
    [3, 2],
    [1, 1],
    [3, 4],
    [2, 3],
    [9, 16],
  ];
  const ratio = width / height;
  const match = known.find(([w, h]) => Math.abs(w / h - ratio) / ratio < 0.02);
  return match ? `${match[0]}:${match[1]}` : ratio.toFixed(2);
}

const query = (reference: WorkReference) =>
  new URLSearchParams({ contentRef: reference.contentRef, ownerRevision: String(reference.ownerRevision) });

export class WorkCoverRequestError extends Error {
  constructor(readonly code: 'conflict' | 'forbidden' | 'unreadable' | 'other') {
    super(code);
  }
}
function failure(status: number) {
  if (status === 409) return new WorkCoverRequestError('conflict');
  if (status === 401 || status === 403) return new WorkCoverRequestError('forbidden');
  if (status === 404 || status === 400) return new WorkCoverRequestError('unreadable');
  return new WorkCoverRequestError('other');
}

export async function readWorkCover(reference: WorkReference, signal?: AbortSignal): Promise<WorkCoverView> {
  const response = await apiFetch(`/api/works/cover?${query(reference)}`, { signal });
  if (!response.ok) throw failure(response.status);
  const view = workCoverViewSchema.parse(await response.json());
  if (view.reference.contentRef !== reference.contentRef || view.reference.ownerRevision !== reference.ownerRevision)
    throw new Error('Cover owner returned another version');
  return view;
}

const candidateSchema = z.object({
  key: z.string(),
  name: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  previewUrl: z.string(),
  source: z.enum(['work-asset', 'thread-image', 'upload']),
  ownerRevision: z.number().int().positive(),
  pick: workCoverPickSchema,
});
export type WorkCoverCandidate = z.infer<typeof candidateSchema>;

export async function readWorkCoverCandidates(reference: WorkReference, signal?: AbortSignal) {
  const response = await apiFetch(`/api/works/cover/candidates?${query(reference)}`, { signal });
  if (!response.ok) throw failure(response.status);
  return z.object({ candidates: z.array(candidateSchema) }).parse(await response.json()).candidates;
}

const savedSchema = z.object({
  status: z.literal('saved'),
  record: z.object({ coverRevision: z.number().int().positive() }).passthrough(),
  cover: workCoverViewSchema,
});
export type WorkCoverSaved = z.infer<typeof savedSchema>;

/** One intent keeps one operation id, so a retry after a lost reply returns the original receipt. */
export async function saveWorkCover(input: {
  reference: WorkReference;
  operationId: string;
  expectedCoverRevision: number;
  choice: WorkCoverChoice;
}): Promise<WorkCoverSaved> {
  const response = await apiFetch('/api/works/cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command: {
        action: 'set-cover',
        reference: { contentRef: input.reference.contentRef, ownerRevision: input.reference.ownerRevision },
        operationId: input.operationId,
        expectedCoverRevision: input.expectedCoverRevision,
        choice: input.choice,
      },
    }),
  });
  if (!response.ok) throw failure(response.status);
  const saved = savedSchema.parse(await response.json());
  window.dispatchEvent(
    new CustomEvent(WORK_COVER_CHANGED_EVENT, {
      detail: { contentRef: input.reference.contentRef, ownerRevision: input.reference.ownerRevision },
    }),
  );
  return saved;
}

export async function uploadWorkCover(file: File): Promise<WorkCoverPick> {
  const body = new FormData();
  body.append('file', file);
  const response = await apiFetch('/api/uploads/work-cover', { method: 'POST', body });
  if (!response.ok) throw failure(response.status);
  const { url } = z.object({ url: z.string() }).parse(await response.json());
  return workCoverPickSchema.parse({ kind: 'upload', uploadUrl: url });
}
