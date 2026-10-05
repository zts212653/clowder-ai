// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import type { ClientSnapshot, CollectiveWorkProjection } from '../client-types.js';
import { collectiveClientNamespace } from '../human-send-custody.js';
import { useCollectiveCollaboration } from '../use-collective-collaboration.js';

function readySnapshot(collectiveId: string): ClientSnapshot {
  return {
    phase: 'ready',
    meta: {
      serviceInstanceId: 'svc_aaaaaaaa',
      bootstrapNeeded: false,
      onboardingComplete: true,
      clientBuildId: 'test',
    },
    me: {
      human: { humanId: 'human_aaaaaaaa', displayName: 'You', createdAt: '2026-09-11T00:00:00.000Z' },
      auth: { provider: 'github', handle: 'operator' },
      collectives: [],
    },
    collective: {
      collectiveId,
      name: collectiveId,
      createdByHumanId: 'human_aaaaaaaa',
      createdAt: '2026-09-11T00:00:00.000Z',
      role: 'steward',
    },
    providers: [],
    events: [],
    connection: 'online',
    delivery: { kind: 'idle' },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('does not project an old Collective command result into the newly selected world', async () => {
  const first = readySnapshot('col_aaaaaaaa');
  const second = readySnapshot('col_bbbbbbbb');
  const currentNamespace = { current: collectiveClientNamespace(first) };
  const setSnapshot = vi.fn();
  const refresh = vi.fn(async () => undefined);
  let resolveRequest: (() => void) | undefined;
  const request: ClientRequest = <Result,>() =>
    new Promise<Result>((resolve) => {
      resolveRequest = () => resolve(undefined as Result);
    });
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness({ snapshot }: { readonly snapshot: ClientSnapshot }) {
    controller = useCollectiveCollaboration({ snapshot, setSnapshot, currentNamespace, request, refresh });
    return null;
  }

  await act(async () => root.render(<Harness snapshot={first} />));
  let command: Promise<void> | undefined;
  await act(async () => {
    command = controller?.proposeWork('evt_aaaaaaaa');
  });
  expect(setSnapshot).toHaveBeenCalledTimes(1);

  currentNamespace.current = collectiveClientNamespace(second);
  await act(async () => root.render(<Harness snapshot={second} />));
  await act(async () => {
    resolveRequest?.();
    await command;
  });

  expect(refresh).not.toHaveBeenCalled();
  expect(setSnapshot).toHaveBeenCalledTimes(1);
});

it('sends an explicit reaction state through the canonical collaboration command path', async () => {
  const snapshot = readySnapshot('col_aaaaaaaa');
  const currentNamespace = { current: collectiveClientNamespace(snapshot) };
  const setSnapshot = vi.fn();
  const refresh = vi.fn(async () => undefined);
  const requestSpy = vi.fn();
  const request: ClientRequest = async <Result,>(path: string, init?: RequestInit) => {
    requestSpy(path, init);
    return undefined as Result;
  };
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness() {
    controller = useCollectiveCollaboration({ snapshot, setSnapshot, currentNamespace, request, refresh });
    return null;
  }

  await act(async () => root.render(<Harness />));
  await act(async () => controller?.setReaction('evt_aaaaaaaa', '🐾', false));

  expect(requestSpy).toHaveBeenCalledOnce();
  const [path, init] = requestSpy.mock.calls[0] ?? [];
  expect(path).toBe('/api/collaboration/reactions/set');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    eventId: 'evt_aaaaaaaa',
    emoji: '🐾',
    active: false,
  });
  expect(refresh).toHaveBeenCalledOnce();
});

it('binds revision feedback and acceptance to the exact current result version', async () => {
  const snapshot = readySnapshot('col_aaaaaaaa');
  const currentNamespace = { current: collectiveClientNamespace(snapshot) };
  const requestSpy = vi.fn();
  const request: ClientRequest = async <Result,>(path: string, init?: RequestInit) => {
    requestSpy(path, init);
    return undefined as Result;
  };
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness() {
    controller = useCollectiveCollaboration({
      snapshot,
      setSnapshot: vi.fn(),
      currentNamespace,
      request,
      refresh: vi.fn(async () => undefined),
    });
    return null;
  }
  const actor = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
  const work: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_source00000',
    sourceLocation: { channelId: 'general' },
    title: '修订结果',
    intendedOutcome: '沿同一 Work 返回新版',
    proposedBy: actor,
    accountableHumanId: actor.humanId,
    dependencyWorkIds: [],
    lifecycle: 'result_ready',
    status: 'result_ready',
    resultEventId: 'evt_result000000',
    resultRevision: 2,
    revision: 5,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:01:00.000Z',
    history: [],
  };

  await act(async () => root.render(<Harness />));
  await act(async () => controller?.requestWorkRevision(work, '请补充恢复证据。'));
  await act(async () => controller?.acceptWorkResult(work));

  expect(requestSpy).toHaveBeenCalledTimes(2);
  expect(requestSpy.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
    [
      '/api/collaboration/work/result/revision',
      expect.objectContaining({
        workId: work.workId,
        expectedRevision: 5,
        resultEventId: work.resultEventId,
        resultRevision: 2,
        feedback: '请补充恢复证据。',
      }),
    ],
    [
      '/api/collaboration/work/result/accept',
      expect.objectContaining({
        workId: work.workId,
        expectedRevision: 5,
        resultEventId: work.resultEventId,
        resultRevision: 2,
      }),
    ],
  ]);
});
