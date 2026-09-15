import { randomUUID } from 'node:crypto';
import { readPersonalChromeConversationAuthorizations, withAuthorizationMutation } from './conversation-binding.mjs';
import { safeConversationTitle, writeConversationTitles } from './conversation-titles.mjs';

const unavailable = (errorCode) => ({ status: 'unavailable', errorCode });

function titleUpdates(message, request, now) {
  if (
    now.getTime() > request.expiresAt ||
    !Array.isArray(message.titles) ||
    message.titles.length > request.conversations.length
  )
    return undefined;
  const seen = new Set();
  const updates = [];
  for (const entry of message.titles) {
    const authorized = request.conversations.find((candidate) => candidate.conversationId === entry?.conversationId);
    const displayTitle = safeConversationTitle(entry?.displayTitle);
    if (!authorized || !displayTitle || seen.has(authorized.conversationId)) return undefined;
    if (Object.keys(entry).some((field) => !['conversationId', 'displayTitle'].includes(field))) return undefined;
    seen.add(authorized.conversationId);
    updates.push({ ...authorized, displayTitle, observedAt: now.toISOString() });
  }
  return updates;
}

/** One bounded, coalesced Native-issued observation; titles never grant route authority. */
export function createConversationTitleExchange({
  authorizationPath,
  sendNative,
  now = () => new Date(),
  timeoutMs = 3000,
}) {
  let pending;
  let stopped = false;
  function finish(request, result) {
    if (pending !== request) return;
    pending = undefined;
    clearTimeout(request.timer);
    request.resolve(result);
  }
  function start() {
    if (pending) return pending;
    const request = { requestId: randomUUID(), conversations: [], expiresAt: now().getTime() + 30_000 };
    request.result = new Promise((resolve) => {
      request.resolve = resolve;
    });
    pending = request;
    request.timer = setTimeout(() => finish(request, unavailable('TITLE_SYNC_TIMEOUT')), timeoutMs);
    request.timer.unref?.();
    request.started = (async () => {
      if (stopped) throw new Error('Host stopped');
      const collection = await readPersonalChromeConversationAuthorizations(authorizationPath, {
        migrateLegacy: false,
      });
      if (pending !== request) return request;
      request.conversations = collection.conversations.map(({ conversationId, authorizedAt }) => ({
        conversationId,
        authorizedAt,
      }));
      if (!request.conversations.length) {
        finish(request, { status: 'synced', updatedCount: 0, requestedCount: 0 });
      } else {
        await sendNative({
          v: 1,
          kind: 'conversation_title_request',
          requestId: request.requestId,
          conversations: request.conversations,
        });
      }
    })().catch(() => {
      finish(request, unavailable('TITLE_SYNC_UNAVAILABLE'));
    });
    return request;
  }
  async function accept(message) {
    if (message?.kind === 'query_conversation_titles') {
      if (message.v === 1) await start().started;
      return true;
    }
    if (message?.kind !== 'conversation_title_result') return false;
    const request = pending;
    if (!request || request.consumed || message.v !== 1 || message.requestId !== request.requestId) return true;
    request.consumed = true;
    const updates = titleUpdates(message, request, now());
    if (!updates) {
      finish(request, unavailable('INVALID_TITLE_RESPONSE'));
      return true;
    }
    try {
      await withAuthorizationMutation(authorizationPath, async (path) => {
        const current = await readPersonalChromeConversationAuthorizations(path, { migrateLegacy: false });
        if (pending !== request) return;
        const applicable = updates.filter(
          (update) =>
            update.observedAt >= update.authorizedAt &&
            current.conversations.some(
              (entry) => entry.conversationId === update.conversationId && entry.authorizedAt === update.authorizedAt,
            ),
        );
        await writeConversationTitles(path, current.conversations, applicable);
        finish(request, {
          status: 'synced',
          updatedCount: applicable.length,
          requestedCount: request.conversations.length,
        });
      });
    } catch {
      finish(request, unavailable('TITLE_WRITE_FAILED'));
    }
    return true;
  }
  return Object.assign(accept, {
    async refreshRequest(request, helperRevision) {
      const validId = typeof request?.requestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(request.requestId);
      const envelope = {
        v: 1,
        kind: 'conversation_titles_refreshed',
        requestId: validId ? request.requestId : 'invalid-request',
      };
      if (
        !validId ||
        request.v !== 1 ||
        request.kind !== 'refresh_conversation_titles' ||
        Object.keys(request).some((key) => !['v', 'kind', 'requestId', 'expectedHelperRevision'].includes(key))
      )
        return { ...envelope, ...unavailable('INVALID_REQUEST') };
      if (request.expectedHelperRevision !== helperRevision) return { ...envelope, ...unavailable('STALE_HELPER') };
      return { ...envelope, ...(await start().result) };
    },
    stop() {
      stopped = true;
      if (pending) finish(pending, unavailable('HOST_STOPPED'));
    },
  });
}
