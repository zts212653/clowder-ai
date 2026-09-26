/**
 * F247 Workspace Agent slice 2a tests: bridge transport precedence and
 * ownership. The officially configured Trigger API path owns the outbound
 * outcome (fail closed — no silent Personal Chrome fallback); when it is not
 * configured the existing Host path behavior is preserved.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCloudBridgeStatusContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { CloudInvokeBridge } from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import {
  WorkspaceAgentTriggerError,
  WorkspaceAgentTriggerHttpAdapter,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-trigger-adapter.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeTriggerAdapter(handler) {
  return new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_test',
    tokenProvider: () => 'token',
    fetchImpl: async (url, init) => handler(url, init),
  });
}

function makeBridgeDeps(overrides = {}) {
  const calls = { host: [], bindings: [], fallbacks: [] };
  const deps = {
    hostAdapter: {
      append_message: async (...args) => {
        calls.host.push(args);
        return { hostMessageId: 'host-msg-x' };
      },
    },
    pinchTabAdapter: null,
    workspaceAgent: null,
    emitFallback: async (params) => {
      calls.fallbacks.push(params);
    },
    threadStore: {
      getCloudCatBindings: async () => {
        calls.bindings.push('read');
        return {};
      },
      updateCloudCatBinding: async (threadId, catId, url) => {
        calls.bindings.push(['write', threadId, catId, url]);
      },
    },
    ...overrides,
  };
  return { deps, calls };
}

/** Deps with an active workspace-agent transport (round-5 snapshot shape). */
function makeWorkspaceAgentDeps(adapter, identity = { workspaceId: 'ws_1', triggerId: 'agtch_test' }) {
  return makeBridgeDeps({
    workspaceAgent: () => ({ adapter, workspaceId: identity.workspaceId, triggerId: identity.triggerId }),
  });
}

const params = {
  catId: 'gpt-pro',
  threadId: 'thread_1',
  userId: 'user-1',
  threadTitle: null,
  participants: [],
  calledBy: 'zcode',
  intent: 'please review',
  sourceMessageId: 'src-msg-1',
};

test('bridge: configured workspace agent owns dispatch — 202 maps to sent, host untouched, no binding io', async () => {
  const triggerCalls = [];
  const { deps, calls } = makeWorkspaceAgentDeps(
    makeTriggerAdapter((url, init) => {
      triggerCalls.push({ url, init });
      return jsonResponse(202, {
        conversation_url: 'https://chatgpt.com/c/wa-1',
        agent_trigger_run_id: 'apirun_1',
      });
    }),
  );
  const bridge = new CloudInvokeBridge(deps);
  const outcome = await bridge.dispatch(params);

  assert.equal(outcome.kind, 'sent');
  assert.equal(outcome.transport, 'workspace-agent');
  assert.equal(outcome.capturedUrl, 'https://chatgpt.com/c/wa-1');
  assert.equal(outcome.providerRunId, 'apirun_1');
  assert.equal(outcome.hostMessageId, undefined);
  assert.equal(calls.host.length, 0, 'host adapter must not be consulted');
  assert.deepEqual(calls.bindings, [], 'workspace-agent path never reads/writes chat-URL bindings');
  const body = JSON.parse(triggerCalls[0].init.body);
  assert.equal(body.conversation_key, 'clowder:ws_1:thread_1');
  assert.equal(triggerCalls[0].init.headers['Idempotency-Key'], 'src-msg-1');
});

test('bridge: workspace agent not configured → existing host path preserved (needs-binding fallback)', async () => {
  const { deps, calls } = makeBridgeDeps();
  const bridge = new CloudInvokeBridge(deps);
  const outcome = await bridge.dispatch(params);
  assert.equal(outcome.kind, 'fallback');
  assert.equal(outcome.reason, 'needs-binding');
  assert.ok(calls.bindings.includes('read'), 'host path still reads bindings');
});

test('bridge: workspace agent 401 fails closed with typed recovery — no silent host fallback', async () => {
  const { deps, calls } = makeWorkspaceAgentDeps(makeTriggerAdapter(() => jsonResponse(401, {})));
  const bridge = new CloudInvokeBridge(deps);
  const outcome = await bridge.dispatch(params);
  assert.equal(outcome.kind, 'fallback');
  assert.equal(outcome.reason, 'workspace-agent-unauthorized');
  assert.equal(calls.host.length, 0, 'auth failure must not reroute to another provider');
  assert.equal(calls.fallbacks.length, 1);
  assert.equal(calls.fallbacks[0].reason, 'workspace-agent-unauthorized');
});

test('bridge: workspace agent 404/409 map to workspace-agent-rejected', async () => {
  for (const status of [404, 409]) {
    const { deps } = makeWorkspaceAgentDeps(makeTriggerAdapter(() => jsonResponse(status, {})));
    const bridge = new CloudInvokeBridge(deps);
    const outcome = await bridge.dispatch(params);
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'workspace-agent-rejected');
  }
});

test('bridge: workspace agent transport fault maps to workspace-agent-failed error', async () => {
  const { deps } = makeWorkspaceAgentDeps(
    makeTriggerAdapter(() => {
      throw new TypeError('Failed to fetch');
    }),
  );
  const bridge = new CloudInvokeBridge(deps);
  const outcome = await bridge.dispatch(params);
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.reason, 'workspace-agent-failed');
});

test('status content: workspace-agent sent produces verified receipt with providerRunId, no hostMessageId', async () => {
  const content = JSON.parse(
    buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome: {
        kind: 'sent',
        capturedUrl: 'https://chatgpt.com/c/wa-1',
        transport: 'workspace-agent',
        providerRunId: 'apirun_7',
      },
      audit: {
        sourceMessageId: 'src-msg-1',
        sourceSender: { kind: 'cat', id: 'zcode' },
        dispatchInvocationId: 'inv-1',
      },
    }),
  );
  assert.equal(content.status, 'sent', '202 is the verified transport boundary — not legacy-unverified');
  assert.equal(content.reason, undefined);
  const receipt = content.outboundReceipt;
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.transport, 'workspace-agent');
  assert.equal(receipt.providerRunId, 'apirun_7');
  assert.equal(receipt.hostMessageId, undefined);
});

test('status content: workspace-agent unauthorized receipt is failed on the workspace-agent transport', () => {
  const content = JSON.parse(
    buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome: {
        kind: 'fallback',
        reason: 'workspace-agent-unauthorized',
        detail: 'token rejected',
      },
      audit: {
        sourceMessageId: 'src-msg-1',
        sourceSender: { kind: 'cat', id: 'zcode' },
        dispatchInvocationId: 'inv-1',
      },
    }),
  );
  assert.equal(content.status, 'unavailable');
  assert.equal(content.reason, 'workspace-agent-unauthorized');
  const receipt = content.outboundReceipt;
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.transport, 'workspace-agent');
  assert.equal(receipt.idempotency.disposition, 'not_attempted');
});

test('workspace-agent-failed status maps to unknown (bounded-transport ambiguity preserved)', () => {
  const content = JSON.parse(
    buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome: {
        kind: 'error',
        reason: 'workspace-agent-failed',
        message: 'request failed before provider response',
      },
      audit: {
        sourceMessageId: 'src-msg-1',
        sourceSender: { kind: 'cat', id: 'zcode' },
        dispatchInvocationId: 'inv-1',
      },
    }),
  );
  assert.equal(content.outboundReceipt.status, 'unknown');
  assert.equal(content.outboundReceipt.transport, 'workspace-agent');
});

test('typed error codes stay distinguishable through the dispatch boundary', () => {
  const unauthorized = new WorkspaceAgentTriggerError('WORKSPACE_AGENT_UNAUTHORIZED', 'rejected', 401);
  assert.equal(unauthorized.code, 'WORKSPACE_AGENT_UNAUTHORIZED');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.name, 'WorkspaceAgentTriggerError');
});

test('replay: re-dispatch of the same exact source reuses the identical Idempotency-Key and conversation_key', async () => {
  const triggerCalls = [];
  const { deps } = makeWorkspaceAgentDeps(
    makeTriggerAdapter((url, init) => {
      triggerCalls.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) });
      return jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/wa-1' });
    }),
  );
  const bridge = new CloudInvokeBridge(deps);
  const first = await bridge.dispatch(params);
  const second = await bridge.dispatch(params);
  assert.equal(first.kind, 'sent');
  assert.equal(second.kind, 'sent');
  assert.equal(triggerCalls.length, 2, 'client does not dedupe — the provider owns Idempotency-Key replay');
  assert.equal(triggerCalls[0].key, 'src-msg-1');
  assert.equal(triggerCalls[1].key, 'src-msg-1', 'exact-source retry must present the same Idempotency-Key');
  assert.equal(triggerCalls[0].body.conversation_key, 'clowder:ws_1:thread_1');
  assert.equal(triggerCalls[1].body.conversation_key, 'clowder:ws_1:thread_1', 'conversation continuity is stable');
});

test('round-4 R3: workspace-agent sent persists the owner-only recovery binding', async () => {
  const writes = [];
  const { deps, calls } = makeBridgeDepsOverrides({
    workspaceAgent: () => ({
      adapter: makeTriggerAdapter(() => jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/wa-1' })),
      workspaceId: 'ws_1',
      triggerId: 'agtch_test',
    }),
    threadStore: {
      getCloudCatBindings: async () => ({}),
      updateCloudCatBinding: async () => {},
      updateCloudCatBindingEntry: async (threadId, catId, entry) => {
        writes.push({ threadId, catId, entry });
      },
    },
  });
  const bridge = new CloudInvokeBridge(deps);
  const outcome = await bridge.dispatch(params);
  assert.equal(outcome.kind, 'sent');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].entry.provider, 'workspace-agent');
  assert.equal(writes[0].entry.workspaceId, 'ws_1');
  assert.equal(writes[0].entry.conversationUrl, 'https://chatgpt.com/c/wa-1');
  assert.equal(calls.bindings.includes('read'), false, 'workspace-agent path still never reads chat-URL bindings');
});

test('round-4 R3: recovery binding write failure does not fail the delivered dispatch', async () => {
  const { deps } = makeBridgeDepsOverrides({
    workspaceAgent: () => ({
      adapter: makeTriggerAdapter(() => jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/wa-2' })),
      workspaceId: 'ws_1',
      triggerId: 'agtch_test',
    }),
    threadStore: {
      getCloudCatBindings: async () => ({}),
      updateCloudCatBinding: async () => {},
      updateCloudCatBindingEntry: async () => {
        throw new Error('store down');
      },
    },
  });
  const bridge = new CloudInvokeBridge(deps);
  const outcome = await bridge.dispatch(params);
  assert.equal(outcome.kind, 'sent', '202 already accepted — anchor write is best-effort');
});

function makeBridgeDepsOverrides(overrides) {
  const calls = { host: [], bindings: [], fallbacks: [] };
  const deps = {
    hostAdapter: {
      append_message: async (...args) => {
        calls.host.push(args);
        return { hostMessageId: 'host-msg-x' };
      },
    },
    pinchTabAdapter: null,
    workspaceAgent: null,
    emitFallback: async (params2) => {
      calls.fallbacks.push(params2);
    },
    threadStore: {
      getCloudCatBindings: async () => ({}),
      updateCloudCatBinding: async () => {},
    },
    ...overrides,
  };
  return { deps, calls };
}

test('round-5 R2: in-flight config change cannot corrupt the binding identity snapshot', async () => {
  const writes = [];
  let liveTriggerId = 'agtch_A';
  // Deferred fetch: the settings config changes WHILE the 202 is pending.
  const deferred = {};
  const deferredResponse = new Promise((resolve) => {
    deferred.resolve = resolve;
  });
  const adapter = {
    get triggerId() {
      return liveTriggerId; // mutable — the exact hazard round-5 R2 found
    },
    trigger: async () => {
      await deferredResponse;
      return { conversationUrl: 'https://chatgpt.com/c/from-A' };
    },
  };
  const { deps } = makeBridgeDepsOverrides({
    workspaceAgent: () => ({
      adapter,
      workspaceId: 'ws_A',
      triggerId: 'agtch_A', // snapshot taken BEFORE the dispatch
    }),
    threadStore: {
      getCloudCatBindings: async () => ({}),
      updateCloudCatBinding: async () => {},
      updateCloudCatBindingEntry: async (threadId, catId, entry) => {
        writes.push(entry);
      },
    },
  });
  const bridge = new CloudInvokeBridge(deps);
  const pending = bridge.dispatch(params);
  liveTriggerId = 'agtch_B'; // owner switches the trigger mid-flight
  deferred.resolve();
  const outcome = await pending;
  assert.equal(outcome.kind, 'sent');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].triggerId, 'agtch_A', 'binding identity must come from the pre-dispatch snapshot');
  assert.equal(writes[0].workspaceId, 'ws_A');
  assert.equal(writes[0].conversationUrl, 'https://chatgpt.com/c/from-A');
});
