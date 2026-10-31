import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createJevPageSelector } from '../../src/domains/concierge/action/jev/JevPageSelector.js';
import type { HomeWorkActionPort } from '../../src/domains/concierge/live/host/home/home-work-action.js';
import { createHomeWorkSource } from '../../src/domains/concierge/live/host/home/home-work-source.js';
import { OwnerHomeActionService } from '../../src/domains/concierge/live/host/home/owner-home-action-service.js';
import type { LiveContextScope } from '../../src/domains/concierge/live/host/live-controlled-context.js';
import { LiveCompanionSessions } from '../../src/domains/concierge/live/LiveCompanionSessions.js';
import { f317LiveHomeRoutes } from '../../src/routes/f317-home-actions.js';

export async function homeWorkFixture(realSource = false) {
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const threadId = threads.create('owner', '回家清单', '/synthetic/work').id;
  const sessions = new LiveCompanionSessions();
  const registry = new InvocationRegistry();
  const catId = createCatId('codex61-sol');
  const credentials = await registry.create('owner', catId, threadId);
  const principal = {
    kind: 'invocation' as const,
    userId: 'owner',
    catId,
    threadId,
    invocationId: credentials.invocationId,
  };
  const call = await sessions.prepare({
    binding: { userId: 'owner', threadId, catId, callId: randomUUID() },
    messageStore: messages,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await sessions.claim(call.id, 'owner', threadId, [catId]);
  await call.configure({
    CAT_CAFE_API_URL: 'http://127.0.0.1:5491',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: threadId,
    CAT_CAFE_CAT_ID: catId,
    CAT_CAFE_INVOCATION_ID: principal.invocationId,
    CAT_CAFE_CALLBACK_TOKEN: credentials.callbackToken,
  });
  await call.ready('native', {
    submitText: async () => 'turn',
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      return {};
    },
  });
  await call.start('offer');
  const artifact = { contentRef: `prepared-media:${'a'.repeat(64)}`, ownerRevision: 2 };
  const published = messages.append({
    userId: 'owner',
    threadId,
    from: { kind: 'agent', catId: createCatId('sonnet') },
    content: '已交付回家清单第2版',
    mentions: [],
    timestamp: Date.now(),
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            kind: 'file',
            v: 1,
            id: 'checklist',
            fileName: '回家清单.png',
            url: '/media/version-2',
            mimeType: 'image/png',
          },
        ],
      },
    },
  });
  if (realSource)
    messages.append({
      userId: 'owner',
      threadId,
      from: { kind: 'agent', catId: createCatId('sonnet') },
      content: '私密作品',
      mentions: [],
      timestamp: Date.now(),
      visibility: 'whisper',
      whisperTo: [createCatId('sonnet')],
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              kind: 'file',
              v: 1,
              id: 'secret',
              fileName: '不应暴露的私密标题.png',
              url: '/media/secret',
              mimeType: 'image/png',
            },
          ],
        },
      },
    });
  const source = {
    kind: 'message' as const,
    threadId,
    messageId: published.id,
    messageRevision: String(published.timestamp),
    item: { kind: 'rich-file' as const, blockId: 'checklist' },
    expectedUrl: '/media/version-2',
  };
  const candidate = {
    id: 'original-publication-v2',
    label: '打开伙伴已交付：回家清单，第2版',
    revision: 'publication-v2',
    destination: {
      threadId: source.threadId,
      messageId: source.messageId,
      item: source.item,
      sourceRef: `message:${threadId}:${published.id}`,
      artifact,
    },
  };
  let available = true;
  let onSelect: () => Promise<void> = async () => {};
  let onConsume: () => Promise<void> = async () => {};
  let choice = 'C0';
  let ackArtifact = artifact;
  const inputs: { ownerRequest: string; candidates: { id: string; label: string }[] }[] = [];
  const grants: unknown[] = [];
  const records: string[] = [];
  const scopes: LiveContextScope[] = [];
  let resolves = 0;
  const clientId = randomUUID();
  let clientToken = '';
  const pages = [{ clientId, clientToken: '', route: '/', threadId, composer: false, sections: [] }];
  let inspectReplies: unknown[] = pages;
  const deliveries: string[] = [];
  let pageChoice = 'C0';
  const deps = {
    ownerUserId: 'owner',
    sessions,
    messages,
    threads,
    isCurrentThread: async () => true,
    work: {
      read: async (scope: LiveContextScope, assertCurrent: () => Promise<void>) => {
        await assertCurrent();
        scopes.push(scope);
        return available ? [candidate] : [];
      },
      resolve: async (_scope: LiveContextScope, selected: typeof candidate, assertCurrent: () => Promise<void>) => {
        await assertCurrent();
        resolves++;
        assert.deepEqual(selected, candidate);
        return available ? { source, artifact } : null;
      },
    },
    selector: createJevPageSelector({
      apiKey: 'fixture-only',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        inputs.push(body.state);
        await onSelect();
        return Response.json({
          model: 'jev-1.13',
          answers: {
            target: {
              type: 'choice',
              choice: body.state.candidates[0]?.id.startsWith('home-page-') ? pageChoice : choice,
              confidence: 1,
            },
            value: { type: 'choice', choice: 'NONE', confidence: 1 },
          },
        });
      },
    }),
    emitter: {
      emit() {},
      emitWithAck: async (_owner: string, event: string, data: unknown) => {
        if (event === 'home:inspect') return inspectReplies;
        const selected = pages.find((page) => page.clientId === (data as { clientId: string }).clientId);
        if (!selected) return [];
        deliveries.push(selected.clientId);
        await onConsume();
        const token = (data as { token: string }).token;
        grants.push(await service.hub.consume('owner', token, selected.clientId, selected.clientToken));
        return [
          {
            token,
            clientId: selected.clientId,
            clientToken: selected.clientToken,
            status: 'applied',
            artifact: ackArtifact,
          },
        ];
      },
    },
    record: async (_scope: LiveContextScope, result: { status: string }) => {
      records.push(result.status);
    },
  };
  const work: HomeWorkActionPort = realSource
    ? createHomeWorkSource({
        ownerUserId: 'owner',
        projectPath: () => '/synthetic/work',
        threads,
        messages,
        tasks: new TaskStore(),
        lineage: () => ({
          resolve: async ({ artifacts }) => artifacts.map(() => ({ ...artifact, currentOwnerRevision: 2 })),
        }),
      })
    : deps.work;
  const service = new OwnerHomeActionService({ ...deps, work });
  clientToken = service.hub.registerClient('owner', clientId, `socket-${clientId}`).clientToken;
  pages[0].clientToken = clientToken;
  const app = Fastify();
  await app.register(f317LiveHomeRoutes, { registry, service });
  const invoke = () =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/home-action',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload: {},
    });
  return {
    app,
    call,
    service,
    candidate,
    source,
    artifact,
    inputs,
    grants,
    records,
    scopes,
    resolves: () => resolves,
    pages,
    deliveries,
    replies: (value: unknown[]) => {
      inspectReplies = value;
    },
    addPage: (route: string) => {
      const id = randomUUID();
      const token = service.hub.registerClient('owner', id, `socket-${id}`).clientToken;
      const page = { clientId: id, clientToken: token, route, threadId, composer: false, sections: [] };
      pages.push(page);
      return page;
    },
    choosePage: (next: string) => {
      pageChoice = next;
    },
    voice: async (parts: readonly string[], session = 'rtc') => {
      await call.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'active' } } });
      await call.observe({
        method: 'thread/realtime/transcript/delta',
        params: { threadId: 'native', role: 'user', delta: parts.join('') },
      });
      for (const text of parts)
        await call.observe({
          method: 'thread/realtime/item/completed',
          params: {
            threadId: 'native',
            item: { id: randomUUID(), realtimeSessionId: session, type: 'transcriptSegment', role: 'user', text },
          },
        });
      await call.observe({
        method: 'thread/realtime/transcript/done',
        params: { threadId: 'native', role: 'user', text: parts.join('') },
      });
      return invoke();
    },
    request: async (text = '打开伙伴刚交的回家清单第2版') => {
      await call.sendText(text, randomUUID());
      return app.inject({
        method: 'POST',
        url: '/api/callbacks/home-action',
        headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
        payload: {},
      });
    },
    hide: () => {
      available = false;
    },
    revokePublication: () => {
      published.visibility = 'whisper';
      published.whisperTo = [createCatId('sonnet')];
    },
    select: (fn: typeof onSelect) => {
      onSelect = fn;
    },
    consume: (fn: typeof onConsume) => {
      onConsume = fn;
    },
    choose: (next: string) => {
      choice = next;
    },
    wrongVersion: () => {
      ackArtifact = { ...artifact, ownerRevision: 1 };
    },
    close: async () => {
      await app.close();
      service.close();
      await call.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'active' } } });
      await call.stop();
    },
  };
}
