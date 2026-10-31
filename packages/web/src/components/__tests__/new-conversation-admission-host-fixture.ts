import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

export interface AdmissionServerDraft {
  version: 1;
  ownerUserId: string;
  threadId: string;
  revision: number;
  text: string;
  contentBlocks?: MessageContent[];
  replyTo?: string;
  updatedAt: number;
}

export interface AdmissionDraftServerState {
  draft: AdmissionServerDraft | null;
  revision: number;
}

export function admissionResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(),
  } as Response;
}

function handleDelete(state: AdmissionDraftServerState, deleteRevisions: number[], expectedRevision: number): Response {
  deleteRevisions.push(expectedRevision);
  if (deleteRevisions.length === 1) return admissionResponse({ error: 'offline' }, 503);
  if (expectedRevision !== state.revision) {
    return admissionResponse({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: state.revision }, 409);
  }
  state.draft = null;
  return admissionResponse({ cleared: true, revision: ++state.revision });
}

function handleComposerDraft(
  ownerUserId: string,
  state: AdmissionDraftServerState,
  deleteRevisions: number[],
  init?: RequestInit,
): Response {
  if (!init || init.method === 'GET') return admissionResponse(state);
  const request = JSON.parse(String(init.body)) as { expectedRevision: number; text?: string };
  if (init.method === 'DELETE') return handleDelete(state, deleteRevisions, request.expectedRevision);
  state.draft = {
    version: 1,
    ownerUserId,
    threadId: 'default',
    revision: ++state.revision,
    text: request.text ?? '',
    updatedAt: Date.now(),
  };
  return admissionResponse({ draft: state.draft });
}

export function installAcceptedRecoveryServer(
  ownerUserId: string,
  state: AdmissionDraftServerState,
  deleteRevisions: number[],
): void {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/session') return admissionResponse({ userId: ownerUserId });
    if (url === '/api/projects/cwd') return admissionResponse({ path: '/work/cafe' });
    if (url === '/api/threads') return admissionResponse({ id: 'created' }, 201);
    if (String(url).endsWith('/composer-draft')) {
      return handleComposerDraft(ownerUserId, state, deleteRevisions, init);
    }
    return admissionResponse({});
  });
}

export function installPendingAdmissionServer(
  ownerUserId: string,
  state: AdmissionDraftServerState,
  pendingStep: 'create' | 'send',
  captureReject: (reject: (error: unknown) => void) => void,
): void {
  const unusedDeleteRevisions: number[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/session') return admissionResponse({ userId: ownerUserId });
    if (url === '/api/projects/cwd') return admissionResponse({ path: '/work/cafe' });
    if (url === '/api/threads') {
      if (pendingStep === 'send') return admissionResponse({ id: 'created' }, 201);
      return new Promise<Response>((_resolve, reject) => captureReject(reject));
    }
    if (String(url).endsWith('/composer-draft')) {
      return handleComposerDraft(ownerUserId, state, unusedDeleteRevisions, init);
    }
    return admissionResponse({});
  });
}

interface AdmissionDraftWrite {
  expectedRevision: number;
  text?: string;
  contentBlocks?: MessageContent[];
  replyTo?: string;
}

export interface DelayedHydrationServerControl {
  deletes: number[];
  puts: AdmissionDraftWrite[];
  hydrationRequested: () => boolean;
  releaseHydration: () => void;
}

function commonAdmissionRoute(url: RequestInfo | URL, ownerUserId: string): Response | null {
  if (url === '/api/session') return admissionResponse({ userId: ownerUserId });
  if (url === '/api/projects/cwd') return admissionResponse({ path: '/work/cafe' });
  if (url === '/api/threads') return admissionResponse({ id: 'created' }, 201);
  return null;
}

function strictDraftMutation(
  ownerUserId: string,
  state: AdmissionDraftServerState,
  deletes: number[],
  puts: AdmissionDraftWrite[],
  init: RequestInit,
): Response {
  const request = JSON.parse(String(init.body)) as AdmissionDraftWrite;
  if (request.expectedRevision !== state.revision) {
    return admissionResponse({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: state.revision }, 409);
  }
  if (init.method === 'DELETE') {
    deletes.push(request.expectedRevision);
    state.draft = null;
    return admissionResponse({ cleared: true, revision: ++state.revision });
  }
  puts.push(request);
  state.draft = {
    version: 1,
    ownerUserId,
    threadId: 'default',
    revision: ++state.revision,
    text: request.text ?? '',
    ...(request.contentBlocks ? { contentBlocks: request.contentBlocks } : {}),
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
    updatedAt: Date.now(),
  };
  return admissionResponse({ draft: state.draft });
}

/**
 * A strict revision server whose first composer read waits until the test
 * releases it. This models a user typing before the durable owner draft has
 * arrived, while keeping create/send and draft CAS behavior real.
 */
export function installDelayedHydrationServer(
  ownerUserId: string,
  state: AdmissionDraftServerState,
): DelayedHydrationServerControl {
  const deletes: number[] = [];
  const puts: AdmissionDraftWrite[] = [];
  let releaseHydration: ((response: Response) => void) | undefined;
  let firstComposerRead = true;

  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const common = commonAdmissionRoute(url, ownerUserId);
    if (common) return common;
    if (typeof url === 'string' && url.startsWith('/api/media/')) {
      return {
        ...admissionResponse({}),
        blob: async () => new Blob(['restored'], { type: 'image/png' }),
      } as Response;
    }
    if (!String(url).endsWith('/composer-draft')) return admissionResponse({});
    if (!init || init.method === 'GET') {
      if (firstComposerRead) {
        firstComposerRead = false;
        return new Promise<Response>((resolve) => {
          releaseHydration = resolve;
        });
      }
      return admissionResponse(state);
    }
    return strictDraftMutation(ownerUserId, state, deletes, puts, init);
  });

  return {
    deletes,
    puts,
    hydrationRequested: () => Boolean(releaseHydration),
    releaseHydration: () => releaseHydration?.(admissionResponse(state)),
  };
}

export function createDelayedHydrationScenario(ownerUserId: string): {
  context: ContextAttachment;
  state: AdmissionDraftServerState;
  server: DelayedHydrationServerControl;
} {
  const context: ContextAttachment = {
    v: 1,
    id: 'restored-context',
    kind: 'thread',
    threadId: 'source-thread',
    title: 'Restored source thread',
  };
  const state: AdmissionDraftServerState = {
    revision: 1,
    draft: {
      version: 1,
      ownerUserId,
      threadId: 'default',
      revision: 1,
      text: 'saved draft from other tab',
      contentBlocks: [
        { type: 'image', url: '/api/media/restored.png' },
        { type: 'context_attachment', attachment: context },
      ],
      replyTo: 'restored-reply',
      updatedAt: Date.now(),
    },
  };
  return { context, state, server: installDelayedHydrationServer(ownerUserId, state) };
}

export interface CanonicalImageRecoveryScenario {
  state: AdmissionDraftServerState;
  events: string[];
  server: {
    hydrationRequested: () => boolean;
    releaseHydration: () => void;
  };
}

function canonicalImageRoute(
  url: RequestInfo | URL,
  ownerUserId: string,
  options: { imageUrl: string; failImage?: boolean },
  events: string[],
): Response | null {
  if (url === '/api/session') return admissionResponse({ userId: ownerUserId });
  if (url === '/api/projects/cwd') return admissionResponse({ path: '/work/cafe' });
  if (url === '/api/threads') {
    events.push('create');
    return admissionResponse({ id: 'created' }, 201);
  }
  if (url !== options.imageUrl) return null;
  events.push(options.failImage ? 'image:failed' : 'image:restored');
  if (options.failImage) return admissionResponse({}, 404);
  return {
    ...admissionResponse({}),
    blob: async () => new Blob(['restored'], { type: 'image/png' }),
  } as Response;
}

export function createCanonicalImageRecoveryScenario(
  ownerUserId: string,
  options: { imageUrl: string; failImage?: boolean; delayedHydration?: boolean },
): CanonicalImageRecoveryScenario {
  const state: AdmissionDraftServerState = {
    revision: 1,
    draft: {
      version: 1,
      ownerUserId,
      threadId: 'default',
      revision: 1,
      text: 'saved image draft',
      contentBlocks: [{ type: 'image', url: options.imageUrl }],
      updatedAt: Date.now(),
    },
  };
  const events: string[] = [];
  const deletes: number[] = [];
  const puts: AdmissionDraftWrite[] = [];
  let releaseHydration: ((response: Response) => void) | undefined;
  let firstComposerRead = true;

  const composerDraftRoute = (url: RequestInfo | URL, init?: RequestInit): Response | Promise<Response> => {
    if (!String(url).endsWith('/composer-draft')) return admissionResponse({});
    if (!init || init.method === 'GET') {
      if (options.delayedHydration && firstComposerRead) {
        firstComposerRead = false;
        return new Promise<Response>((resolve) => {
          releaseHydration = resolve;
        });
      }
      return admissionResponse(state);
    }
    const request = JSON.parse(String(init.body)) as AdmissionDraftWrite;
    if (init.method === 'DELETE') events.push(`delete:${request.expectedRevision}`);
    else events.push(`put:${request.expectedRevision + 1}`);
    return strictDraftMutation(ownerUserId, state, deletes, puts, init);
  };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    return canonicalImageRoute(url, ownerUserId, options, events) ?? composerDraftRoute(url, init);
  });

  return {
    state,
    events,
    server: {
      hydrationRequested: () => Boolean(releaseHydration),
      releaseHydration: () => releaseHydration?.(admissionResponse(state)),
    },
  };
}
