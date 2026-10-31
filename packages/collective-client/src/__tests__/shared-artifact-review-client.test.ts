import { expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import {
  collectiveArtifactClient,
  type SharedArtifact,
  type SharedMarkdownView,
} from '../collective-artifact-client.js';

it('recreates the same public reply and owner command after an unknown response, and rejects a forged pending target before sending', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const messages: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const request: ClientRequest = async <Result>(path: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (path === '/api/events/human') {
      messages.push(input);
      return { eventId: 'public-reply' } as Result;
    }
    commands.push(input);
    if (commands.length === 1) throw new Error('unknown owner response');
    return {
      value: {
        annotationId: 'annotation',
        ownerRevision: 1,
        receipt: {
          reviewId: 'review',
          receiptRef: 'real-receipt',
          revision: 4,
          actor: { kind: 'human', actorId: 'bob' },
        },
      },
    } as Result;
  };
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    contentRef: 'content',
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
  } as SharedArtifact;
  const view = {
    ownerRevision: 1,
    blobDigest: 'digest',
    view: { canReply: true, review: { reviewId: 'review', revision: 3 } },
  } as SharedMarkdownView;
  const input = {
    artifact,
    view,
    reply: {
      artifactId: 'artifact',
      ownerRevision: 1,
      blobDigest: 'digest',
      annotationId: 'annotation',
      messageEventId: 'comment',
      authorHumanId: 'alice',
    },
    body: '在原讨论回复',
    recipient: { kind: 'human' as const, humanId: 'alice' },
    humanId: 'bob',
  };
  const api = () =>
    collectiveArtifactClient(request, { serviceInstanceId: 'service', collectiveId: 'collective' }, 'bob');
  try {
    await expect(api().sendReply(input)).rejects.toThrow('unknown owner response');
    const saved = [...storage.entries()][0];
    expect(saved).toBeDefined();
    const forged = JSON.parse(saved[1]);
    forged.intent.annotationId = 'another-annotation';
    storage.set(saved[0], JSON.stringify(forged));
    await expect(api().sendReply(input)).rejects.toThrow('批注引用已改变');
    expect(messages).toHaveLength(1);
    storage.set(saved[0], saved[1]);
    await api().sendReply({
      ...input,
      view: { ...view, view: { ...view.view, review: { ...view.view.review, revision: 8 } } },
    });
    expect(messages[1]).toEqual(messages[0]);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      ownerRevision: 1,
      payload: {
        action: { kind: 'reply', annotationId: 'annotation', messageEventId: 'public-reply' },
        expectedReviewRevision: 3,
      },
    });
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps a state decision UUID and its original CAS after an unknown result across client recreation', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const commands: Record<string, unknown>[] = [];
  const request: ClientRequest = async <Result>(_path: string, init?: RequestInit) => {
    commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (commands.length === 1) throw new Error('unknown state result');
    return {
      value: {
        annotationId: 'annotation',
        ownerRevision: 2,
        receipt: {
          reviewId: 'review',
          receiptRef: 'state-receipt',
          revision: 4,
          actor: { kind: 'human', actorId: 'bob' },
        },
      },
    } as Result;
  };
  const artifact = { artifactId: 'artifact', sourceEventId: 'source' } as SharedArtifact;
  const view = {
    ownerRevision: 2,
    view: { canWrite: true, review: { reviewId: 'review', revision: 3 } },
  } as SharedMarkdownView;
  const input = { artifact, view, annotationId: 'annotation', state: 'resolved' as const, humanId: 'bob' };
  const api = () =>
    collectiveArtifactClient(request, { serviceInstanceId: 'service', collectiveId: 'collective' }, 'bob');
  try {
    await expect(api().setAnnotationState(input)).rejects.toThrow('unknown state result');
    await api().setAnnotationState({
      ...input,
      view: { ...view, view: { ...view.view, review: { ...view.view.review, revision: 9 } } },
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
