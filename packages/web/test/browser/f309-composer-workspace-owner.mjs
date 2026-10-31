import { mkdir, writeFile } from 'node:fs/promises';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';

/** Canonical owner draft routes and CAS, independent of the browser/session mirror. No model or Redis. */
export function startComposerWorkspaceOwner(dataDir, { configure } = {}) {
  return startRealWorkspaceOwner(dataDir, {
    configure: async ({ app, content }) => {
      const { MessageStore } = await import('../../../api/dist/domains/cats/services/stores/ports/MessageStore.js');
      const { composerDraftRecallRoutes } = await import('../../../api/dist/routes/composer-draft-recall.js');
      const draftStore = new MessageStore();
      const draftRequests = [];
      app.addHook('onRequest', async (request) => {
        if (request.url === `/api/threads/${THREAD_ID}/composer-draft`)
          draftRequests.push({ event: 'received', method: request.method, at: Date.now() });
      });
      app.addHook('onResponse', async (request, reply) => {
        if (request.url === `/api/threads/${THREAD_ID}/composer-draft`)
          draftRequests.push({
            event: 'responded',
            method: request.method,
            status: reply.statusCode,
            body: request.body,
            at: Date.now(),
          });
      });
      const extra = await configure?.({ app, content, draftStore });
      await app.register(composerDraftRecallRoutes, {
        messageStore: draftStore,
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      });
      return { readDraft: () => draftStore.getOwnerComposerDraft('operator', THREAD_ID), draftRequests, ...extra };
    },
  });
}

export async function routeComposerDraft(route, url, owner) {
  if (url.pathname !== `/api/threads/${THREAD_ID}/composer-draft`) return false;
  const request = route.request();
  // A browser-context APIRequestContext is disposed on close, which would cancel the forwarded owner write.
  // Once the browser issued a keepalive request, forward it independently; never wait for a save before closing.
  const response = await fetch(`${owner.api}${url.pathname}`, {
    method: request.method(),
    headers: request.headers(),
    body: request.postDataBuffer() ?? undefined,
  });
  const body = Buffer.from(await response.arrayBuffer());
  try {
    await route.fulfill({ status: response.status, contentType: 'application/json', body });
  } catch (error) {
    if (!/Target.*closed|Request context disposed/i.test(String(error))) throw error;
  }
  return true;
}

export async function closeComposerWorkspaceOwner(context, owner) {
  try {
    if (context.pages().length) await context.unrouteAll({ behavior: 'ignoreErrors' });
  } finally {
    try {
      await context.close();
    } finally {
      await owner.close();
    }
  }
}

/** Opt-in observations only; normal journeys do not wrap fetch or change their timing. */
export async function observeComposerDraftExit(context) {
  const browserDraftEvents = [];
  if (process.env.F309_DRAFT_DIAGNOSTICS !== '1') return browserDraftEvents;
  await context.addInitScript(() => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const report = (event) => console.debug('f309-draft-diagnostic:', JSON.stringify({ ...event, at: Date.now() }));
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/composer-draft'))
        report({ event: 'fetch', method: init?.method ?? 'GET', body: init?.body, keepalive: init?.keepalive });
      return fetch.call(window, input, init);
    };
    window.addEventListener('pagehide', () => {
      report({
        event: 'pagehide',
        input: document.querySelector('textarea[aria-label="消息输入框"]')?.value,
        contextDrafts: sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts'),
      });
    });
  });
  context.on('page', (page) => {
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('f309-draft-diagnostic: ')) browserDraftEvents.push(JSON.parse(text.slice(23)));
    });
  });
  return browserDraftEvents;
}

export async function captureComposerDraftFailure({ directory, prefix, page, owner, browserDraftEvents, sent, error }) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/${prefix}-failure.json`,
    `${JSON.stringify({ error: String(error), owner: await owner.readDraft(), draftRequests: owner.draftRequests, browserDraftEvents, sent })}\n`,
  );
  if (page) await page.screenshot({ path: `${directory}/${prefix}-failure.png` }).catch(() => {});
}
