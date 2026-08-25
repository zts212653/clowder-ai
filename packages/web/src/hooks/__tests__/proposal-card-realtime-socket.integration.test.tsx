import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ApprovalEnvelope, type ApprovalPublication, createCatId } from '@cat-cafe/shared';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalPublishDraft } from '../../../../api/src/domains/approval-hub/ApprovalIngress';
import type { ApprovalPublicationStore } from '../../../../api/src/domains/approval-hub/ports/ApprovalPublicationStore';

const THREAD_ID = 'source-thread';
const OTHER_THREAD_ID = 'other-thread';
const PROPOSAL_ID = 'proposal-realtime-card';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for proposal-card integration condition`);
}

class FakePublicationStore implements ApprovalPublicationStore {
  publication: ApprovalPublication = { state: 'staged', stagedAt: Date.now() };

  getPublication(): ApprovalPublication {
    return this.publication;
  }

  commitEnvelope(_proposalId: string, envelope: ApprovalEnvelope): void {
    this.publication = { state: 'anchored', envelope };
  }

  abortStaged(_proposalId: string, reason: string): void {
    this.publication = { state: 'tombstoned', failedAt: Date.now(), reason };
  }
}

describe('F128 proposal card realtime socket journey', () => {
  let httpServer: HttpServer;
  let socketManager: import('../../../../api/src/infrastructure/websocket/SocketManager').SocketManager;
  let messageStore: import('../../../../api/src/domains/cats/services/stores/ports/MessageStore').MessageStore;
  let ingress: import('../../../../api/src/domains/approval-hub/ApprovalIngress').ApprovalIngress;
  let useSocket: typeof import('../useSocket').useSocket;
  let mergeReplaceHydrationMessages: typeof import('../useChatHistory').mergeReplaceHydrationMessages;
  let useChatStore: typeof import('@/stores/chatStore').useChatStore;
  let RichBlocks: typeof import('@/components/rich/RichBlocks').RichBlocks;
  let initialChatState: ReturnType<typeof useChatStore.getState>;
  let container: HTMLDivElement;
  let root: Root;
  let socketReady: Promise<void>;
  let resolveSocketReady: (() => void) | undefined;
  let canonicalStatus: 'pending' | 'withdrawn';
  let publicationStore: FakePublicationStore;
  let publishDraft: ApprovalPublishDraft;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    if (initialChatState && useChatStore) useChatStore.setState(initialChatState, true);
    socketManager?.close();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    vi.unstubAllEnvs();
  });

  async function setUpJourney(activeThreadId = THREAD_ID): Promise<void> {
    vi.resetModules();
    canonicalStatus = 'pending';
    const { SocketManager } = await import('../../../../api/src/infrastructure/websocket/SocketManager');
    const { MessageStore } = await import('../../../../api/src/domains/cats/services/stores/ports/MessageStore');
    const { ApprovalIngress } = await import('../../../../api/src/domains/approval-hub/ApprovalIngress');

    messageStore = new MessageStore();
    httpServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/session') {
        response.end('{}');
        return;
      }
      if (request.url === `/api/proposals/${PROPOSAL_ID}`) {
        response.end(JSON.stringify({ proposal: { proposalId: PROPOSAL_ID, status: canonicalStatus } }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    socketManager = new SocketManager(httpServer);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const port = (httpServer.address() as AddressInfo).port;
    vi.stubEnv('NEXT_PUBLIC_API_URL', `http://127.0.0.1:${port}`);

    ({ useSocket } = await import('../useSocket'));
    ({ mergeReplaceHydrationMessages } = await import('../useChatHistory'));
    ({ useChatStore } = await import('@/stores/chatStore'));
    ({ RichBlocks } = await import('@/components/rich/RichBlocks'));
    initialChatState = useChatStore.getState();
    useChatStore.setState({
      currentThreadId: activeThreadId,
      messages: [
        {
          id: 'streaming-assistant',
          type: 'assistant',
          catId: 'codex-sol',
          content: '仍在流式输出',
          isStreaming: true,
          origin: 'stream',
          timestamp: Date.now() - 1_000,
        },
      ],
      threadStates: {},
    });
    ingress = new ApprovalIngress({ messageStore, socketManager });

    socketReady = new Promise<void>((resolve) => {
      resolveSocketReady = resolve;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Journey activeThreadId={activeThreadId} />));
    await socketReady;
    await waitFor(() => socketManager.getIO().sockets.adapter.rooms.has(`thread:${activeThreadId}`));
    for (const socket of socketManager.getIO().sockets.sockets.values()) {
      await socket.leave(`thread:${activeThreadId}`);
      await socket.leave(`thread:${THREAD_ID}`);
    }
    expect(socketManager.getIO().sockets.adapter.rooms.has('user:default-user')).toBe(true);
    await waitFor(() => !socketManager.getIO().sockets.adapter.rooms.has(`thread:${THREAD_ID}`));
  }

  function Journey({ activeThreadId }: { activeThreadId: string }) {
    const messages = useChatStore((state) => state.messages);
    const { socketConnected } = useSocket({ onMessage: () => {} }, activeThreadId, [activeThreadId]);
    useEffect(() => {
      if (!socketConnected) return;
      resolveSocketReady?.();
    }, [socketConnected]);
    return (
      <main data-active-thread={activeThreadId}>
        {messages.map((message) => (
          <article key={message.id} data-message-id={message.id}>
            {message.extra?.rich?.blocks ? (
              <RichBlocks blocks={message.extra.rich.blocks} messageId={message.id} />
            ) : (
              message.content
            )}
          </article>
        ))}
      </main>
    );
  }

  async function publishProposal(): Promise<string> {
    const origin = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '请开一个新 thread',
      mentions: [],
      timestamp: Date.now() - 500,
      threadId: THREAD_ID,
    });
    publishDraft = {
      producerId: 'F128',
      canonicalProposalId: PROPOSAL_ID,
      ownerUserId: 'default-user',
      requesterCatId: createCatId('codex-sol'),
      originRef: { kind: 'message', threadId: THREAD_ID, messageId: origin.id },
      cardThreadId: THREAD_ID,
      cardContent: 'New thread: realtime proposal card',
      cardBlock: {
        id: `proposal-${PROPOSAL_ID}`,
        kind: 'card',
        v: 1,
        title: '提议新建 thread：Realtime proposal card',
        bodyMarkdown: '实时审批卡',
        tone: 'info',
        fields: [],
        actions: [
          { label: '批准并创建', action: 'propose:approve', payload: { proposalId: PROPOSAL_ID } },
          { label: '驳回', action: 'propose:reject', payload: { proposalId: PROPOSAL_ID } },
        ],
      },
      createdAt: Date.now(),
    };
    publicationStore = new FakePublicationStore();
    const envelope = await ingress.publish(publishDraft, publicationStore);
    return envelope.approvalCardRef.messageId;
  }

  it('projects a committed card into the already-open streaming thread even when its room event is dropped', async () => {
    await setUpJourney();
    let cardMessageId = '';
    await act(async () => {
      cardMessageId = await publishProposal();
      await waitFor(() => useChatStore.getState().messages.some((message) => message.id === cardMessageId));
    });
    await waitFor(() => container.querySelector(`[data-message-id="${cardMessageId}"]`) !== null);

    expect(container.textContent).toContain('Realtime proposal card');
    expect(container.querySelectorAll(`[data-message-id="${cardMessageId}"]`)).toHaveLength(1);
    expect(
      [...container.querySelectorAll('[data-message-id]')].map((node) => node.getAttribute('data-message-id')),
    ).toEqual(['streaming-assistant', cardMessageId]);

    const initialSocketId = [...socketManager.getIO().sockets.sockets.keys()][0];
    for (const socket of socketManager.getIO().sockets.sockets.values()) socket.conn.close();
    await act(async () => {
      await waitFor(() => {
        const socketIds = [...socketManager.getIO().sockets.sockets.keys()];
        return socketIds.length === 1 && socketIds[0] !== initialSocketId;
      });
      await ingress.publish(publishDraft, publicationStore);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(container.querySelectorAll(`[data-message-id="${cardMessageId}"]`)).toHaveLength(1);

    const currentMessages = useChatStore.getState().messages;
    const snapshotCard = currentMessages.find((message) => message.id === cardMessageId);
    expect(snapshotCard).toBeDefined();
    if (!snapshotCard) throw new Error('Expected the persisted proposal card in the active thread snapshot');
    const replay = mergeReplaceHydrationMessages([snapshotCard], currentMessages, {});
    act(() => useChatStore.getState().hydrateThread(THREAD_ID, replay.messages, false));
    expect(container.querySelectorAll(`[data-message-id="${cardMessageId}"]`)).toHaveLength(1);
    expect(
      [...container.querySelectorAll('[data-message-id]')].map((node) => node.getAttribute('data-message-id')),
    ).toEqual(['streaming-assistant', cardMessageId]);

    canonicalStatus = 'withdrawn';
    await act(async () => {
      socketManager.emitToUser('default-user', 'proposal_updated', {
        proposalId: PROPOSAL_ID,
        status: 'withdrawn',
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await waitFor(() => container.textContent?.includes('已撤回') === true);
  });

  it('keeps a card for another thread out of the active DOM', async () => {
    await setUpJourney(OTHER_THREAD_ID);
    const cardMessageId = await publishProposal();
    await waitFor(() => useChatStore.getState().threadStates[THREAD_ID]?.messages.some((m) => m.id === cardMessageId));

    expect(container.querySelector(`[data-message-id="${cardMessageId}"]`)).toBeNull();
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});
