import type { CollectiveClientContext } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveConnectionProjection } from '../collective-client';
import { type CollectiveWorkPolicyBridge, useCollectiveWorkPolicyBridge } from '../use-collective-work-policy-bridge';

const context = {
  type: 'collective:client-context',
  bridgeId: 'bridge_12345678',
  contextId: 'context_12345678',
  revision: 1,
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  humanId: 'human_12345678',
  channelId: 'general',
  channelIds: ['general'],
  openCafe: false,
} as CollectiveClientContext;
const connection = {
  serviceUrl: 'http://localhost:5179',
  serviceInstanceId: context.serviceInstanceId,
  collectiveId: context.collectiveId,
  connectionId: 'con_12345678',
  authorizedHumanId: context.humanId,
  authorityStatus: 'connected',
} as CollectiveConnectionProjection;
let api: CollectiveWorkPolicyBridge;
let frame: HTMLIFrameElement;
let root: Root;
let container: HTMLDivElement;
function Harness({ revision = 1 }: { revision?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  api = useCollectiveWorkPolicyBridge(ref, connection, { ...context, revision });
  return <iframe ref={ref} title="fixture Service frame" />;
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  localStorage.clear();
  await act(async () => root.render(<Harness />));
  frame = container.querySelector('iframe') as HTMLIFrameElement;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const emit = async (
  data: unknown,
  origin = connection.serviceUrl,
  source: MessageEventSource | null = frame.contentWindow,
) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  });
it('accepts receipt only from the exact origin/window/current coordinates and keeps retry identity until adoption acknowledgement', async () => {
  const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');
  const action = { kind: 'set_mode' as const, decisionMode: 'manual' as const };
  let received: unknown;
  const operation = api.command(action).then((value) => {
    received = value;
  });
  const message = post.mock.calls[0]?.[0];
  expect(message).toBeDefined();
  expect(JSON.stringify(message)).not.toMatch(/Bearer|callbackToken|sessionToken/);
  const reply = {
    ...message,
    type: 'collective:client-work-policy-reply',
    result: { state: 'registered', receipt: { policyRevision: 2 } },
  };
  delete reply.action;
  await emit(reply, 'http://evil.test');
  await emit(reply, connection.serviceUrl, window);
  await emit({ ...reply, connectionId: 'con_other123' });
  await emit({ ...reply, contextRevision: 99 });
  expect(received).toBeUndefined();
  await emit(reply);
  await operation;
  expect(received).toEqual({ policyRevision: 2 });
  const again = api.command(action);
  expect(post.mock.calls[1]?.[0].commandId).toBe(message.commandId);
  await emit(reply);
  await again;
  api.acknowledge(action);
  const third = api.command(action);
  const next = post.mock.calls[2]?.[0];
  expect(next.commandId).not.toBe(message.commandId);
  await emit({ ...reply, commandId: next.commandId });
  await third;
});
it('refuses a completed old-generation receipt and permission request after context revision changes', async () => {
  const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');
  const operation = api.command({ kind: 'set_mode', decisionMode: 'manual' }).catch(() => undefined);
  const message = post.mock.calls[0]?.[0];
  await act(async () => root.render(<Harness revision={2} />));
  const reply = {
    ...message,
    type: 'collective:client-work-policy-reply',
    result: { state: 'registered', receipt: { policyRevision: 2 } },
  };
  delete reply.action;
  await emit(reply);
  await emit({ ...reply, type: 'collective:client-work-permission-request', result: undefined, commandId: undefined });
  expect(api.permissionRequest).toBeUndefined();
  await act(async () => root.unmount());
  await operation;
  root = createRoot(container);
});
