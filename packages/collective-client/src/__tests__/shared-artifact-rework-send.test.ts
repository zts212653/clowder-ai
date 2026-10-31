import { expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import {
  collectiveArtifactClient,
  type SharedArtifact,
  type SharedMarkdownView,
} from '../collective-artifact-client.js';

it('retries the same sealed rework send and exact owner version after losing its preparation response', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const publications: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const request: ClientRequest = async <Result>(path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (path.endsWith('/requests/publish')) {
      publications.push(body);
      return { source: { eventId: 'evt_rework-send-0001' } } as Result;
    }
    commands.push(body);
    if (commands.length === 1) throw new Error('lost preparation response');
    return { value: {} } as Result;
  };
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
  } as SharedArtifact;
  const view = { ownerRevision: 2, view: { review: { revision: 4 } } } as SharedMarkdownView;
  const api = collectiveArtifactClient(request, { serviceInstanceId: 'service', collectiveId: 'collective' }, 'human');
  const rework = { requestId: 'prior-request', proposalRef: 'prior-proposal' };
  const input = {
    artifact,
    view,
    rework,
    selections: [],
    body: '基于第2版重做',
    recipient: {
      kind: 'agent' as const,
      humanId: 'human_aaaaaaaa',
      connectionId: 'con_aaaaaaaa',
      agentId: 'codex61-sol',
      participationRevision: 2,
    },
  };
  try {
    await expect(api.sendFeedback(input)).rejects.toThrow('lost preparation response');
    await api.sendFeedback(input);
    expect(publications).toHaveLength(2);
    expect(publications[1]).toEqual(publications[0]);
    expect(publications[0]).toMatchObject({ rework, ownerRevision: 2, annotationIds: [] });
    expect(publications[0]).not.toHaveProperty('selections');
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({ ownerRevision: 2, payload: { rework, annotationIds: [] } });
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
