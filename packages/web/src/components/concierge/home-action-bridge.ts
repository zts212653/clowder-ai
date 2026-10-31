import type { OwnerComposerDraft } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  type ComposerDraftClientSnapshot,
  flushComposerDraft,
  observeComposerDraft,
} from '../composer-draft-flush-registry';
import { contextAttachmentsFromDraft, imageUrlsFromDraft } from '../durable-composer-draft-helpers';
import { SETTINGS_SECTIONS } from '../settings/settings-nav-config';
import { getThreadHref, pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';
import { afterPaintUntil } from './home-after-paint';
import { applyHomePublication } from './home-work-publication';

export function homeHubObservation(clientId: string, clientToken: string) {
  if (document.visibilityState !== 'visible') return null;
  const route = window.location.pathname + window.location.search;
  const threadId =
    window.location.pathname === '/' || window.location.pathname.startsWith('/thread/')
      ? useChatStore.getState().currentThreadId
      : null;
  return {
    clientId,
    clientToken,
    route,
    threadId,
    composer: Boolean(threadId && observeComposerDraft(threadId)?.ready),
    sections: SETTINGS_SECTIONS.map(({ id, label }) => ({ id, label })),
  };
}

type Navigation =
  | { kind: 'thread'; threadId: string }
  | { kind: 'settings'; sectionId: string }
  | { kind: 'publication' };
interface Grant {
  kind: 'navigate' | 'updated';
  clientId: string;
  baseRoute: string;
  expiresAt: number;
  action?: Navigation;
  draft?: OwnerComposerDraft;
}
function validGrant(value: unknown, clientId: string, route: string): value is Grant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<Grant>;
  return (
    grant.clientId === clientId &&
    grant.baseRoute === route &&
    typeof grant.expiresAt === 'number' &&
    grant.expiresAt > Date.now() &&
    grant.expiresAt <= Date.now() + 10_000 &&
    ['navigate', 'updated'].includes(grant.kind ?? '')
  );
}

export interface HomeCommandInput {
  token: string;
  clientId: string;
  clientToken: string;
  signal: AbortSignal;
  navigate(path: string): void;
  captureBeforeSettings(): void;
}
export type HomeOutcome = {
  status: 'applied' | 'blocked' | 'unconfirmed';
  reason?: string;
  artifact?: { contentRef: string; ownerRevision: number };
};
type HubState = NonNullable<ReturnType<typeof homeHubObservation>>;

/** Executes only the Host's one-use grant through the original navigation and draft ports. */
export async function applyHomeCommand(input: HomeCommandInput): Promise<HomeOutcome> {
  const state = homeHubObservation(input.clientId, input.clientToken);
  if (!state || input.signal.aborted || useChatStore.getState().pendingChatInsert)
    return { status: 'blocked', reason: 'hub_not_available' };
  const snapshot =
    state.threadId && state.composer ? await flushComposerDraft(state.threadId, { includeRevision: true }) : null;
  if (input.signal.aborted || homeHubObservation(input.clientId, input.clientToken)?.route !== state.route)
    return { status: 'blocked', reason: 'hub_view_changed' };
  const response = await apiFetch(`/api/concierge/home/commands/${encodeURIComponent(input.token)}`, {
    method: 'POST',
    signal: input.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: input.clientId,
      clientToken: input.clientToken,
      ...(snapshot?.serverRevision !== undefined ? { expectedRevision: snapshot.serverRevision } : {}),
    }),
  });
  const grant: unknown = await response.json();
  if (
    !response.ok ||
    !validGrant(grant, input.clientId, state.route) ||
    input.signal.aborted ||
    homeHubObservation(input.clientId, input.clientToken)?.route !== state.route
  )
    return {
      status:
        response.ok && grant && typeof grant === 'object' && 'kind' in grant && grant.kind === 'updated'
          ? 'unconfirmed'
          : 'blocked',
      reason: 'owner_grant_not_current',
    };
  return grant.kind === 'updated' ? applyDraftGrant(input, grant, state, snapshot) : applyNavigationGrant(input, grant);
}

async function applyDraftGrant(
  input: HomeCommandInput,
  grant: Grant,
  state: HubState,
  snapshot: ComposerDraftClientSnapshot | null,
): Promise<HomeOutcome> {
  const draft = grant.draft;
  if (
    !state.threadId ||
    !snapshot ||
    !draft ||
    draft.threadId !== state.threadId ||
    draft.revision !== (snapshot.serverRevision ?? -1) + 1
  )
    return { status: 'unconfirmed', reason: 'draft_receipt_mismatch' };
  useChatStore.getState().setPendingChatInsert({
    threadId: draft.threadId,
    text: draft.text,
    authoritative: true,
    serverRevision: draft.revision,
    clientSnapshot: snapshot,
    imageUrls: imageUrlsFromDraft(draft),
    contextAttachments: contextAttachmentsFromDraft(draft),
    ...(draft.replyTo ? { replyToId: draft.replyTo } : {}),
  });
  const rendered = await afterPaintUntil(
    () => {
      const observed = observeComposerDraft(draft.threadId);
      return (
        !useChatStore.getState().pendingChatInsert &&
        Boolean(observed?.ready && observed.revision >= draft.revision && observed.text.includes(draft.text))
      );
    },
    input.signal,
    grant.expiresAt,
  );
  if (!rendered) return { status: 'unconfirmed', reason: 'draft_dom_not_confirmed' };
  const saved = await flushComposerDraft(draft.threadId, { includeRevision: true });
  const observed = observeComposerDraft(draft.threadId);
  return saved && observed?.text === saved.text && !input.signal.aborted
    ? { status: 'applied' }
    : { status: 'unconfirmed', reason: 'draft_persistence_not_confirmed' };
}

async function applyNavigationGrant(input: HomeCommandInput, grant: Grant): Promise<HomeOutcome> {
  const action = grant.action;
  if (action?.kind === 'publication') return applyHomePublication(input, action, grant.expiresAt);
  if (action?.kind === 'thread' && /^[A-Za-z0-9_-]{1,160}$/.test(action.threadId)) {
    const href = getThreadHref(action.threadId);
    if (window.location.pathname === '/' || window.location.pathname.startsWith('/thread/'))
      pushThreadRouteWithHistory(action.threadId, window);
    else input.navigate(href);
    const applied = await afterPaintUntil(
      () => {
        const current = useChatStore.getState();
        return (
          window.location.pathname === href &&
          document.visibilityState === 'visible' &&
          current.currentThreadId === action.threadId &&
          !current.isLoadingHistory &&
          Boolean(observeComposerDraft(action.threadId)?.ready)
        );
      },
      input.signal,
      grant.expiresAt,
    );
    return applied ? { status: 'applied' } : { status: 'unconfirmed', reason: 'thread_dom_not_confirmed' };
  }
  if (action?.kind === 'settings' && SETTINGS_SECTIONS.some((s) => s.id === action.sectionId)) {
    input.captureBeforeSettings();
    input.navigate(`/settings?s=${encodeURIComponent(action.sectionId)}`);
    const applied = await afterPaintUntil(
      () => Boolean(document.querySelector(`[data-settings-section="${action.sectionId}"]`)),
      input.signal,
      grant.expiresAt,
    );
    return applied ? { status: 'applied' } : { status: 'unconfirmed', reason: 'settings_dom_not_confirmed' };
  }
  return { status: 'blocked', reason: 'unsupported_owner_target' };
}
