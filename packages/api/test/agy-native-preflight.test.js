import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveContextContinuity,
  supportsProviderContinuityPreflight,
} from '../dist/domains/cats/services/agents/invocation/context-continuity.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-preflight-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const order = [];
  let observedId = 'native-one';
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: { enabled: true, autoApprove: true, model: 'gemini-3.8-flash-high', homeRoot: join(root, 'profiles') },
    l0CompilerFn: async () => '# Identity\nFixture cat.',
    spawnCliFn: async function* (options) {
      let input;
      assert.equal(options.stdinInput, undefined, 'no prompt is frozen before native init');
      options.onStdinReady((value) => {
        order.push('write');
        input = value;
      });
      order.push('init');
      yield {
        event: 'init',
        conversation_id: observedId,
        init: {
          cwd: options.cwd,
          agent: options.args[options.args.indexOf('--agent') + 1],
          model: 'gemini-3.8-flash-high',
          permission_mode: 'always-proceed',
        },
      };
      assert.equal(JSON.parse(input).message.content[0].text, 'final provider-confirmed prompt');
      yield { event: 'result', result: { conversation_id: observedId, status: 'SUCCESS', response: 'done' } };
    },
  });
  return {
    workspace,
    service,
    order,
    replace: () => {
      observedId = 'wrong-conversation';
    },
  };
}

test('Native continuity sends only the generation settled after verified provider init', async (t) => {
  const f = fixture(t),
    evidence = [];
  const preflight = {
    settle: async ({ evidence: value }) => {
      f.order.push('settle');
      evidence.push(value);
      return { prompt: 'final provider-confirmed prompt', promptGenerationId: 'fixture-generation' };
    },
  };
  const run = async (binding) => {
    const messages = [];
    for await (const message of f.service.invokeWithContinuityPreflight(preflight, {
      workingDirectory: f.workspace,
      ...(binding ? { sessionId: binding.cliSessionId, nativeSessionBinding: binding } : {}),
      beforeProviderLaunch: async (request) => {
        f.order.push('record');
        assert.equal(request.message.body, 'final provider-confirmed prompt');
      },
    }))
      messages.push(message);
    assert.equal(messages.at(-1).errorCode, undefined);
    return messages.find((m) => m.nativeSessionBinding).nativeSessionBinding;
  };
  const binding = await run();
  await run(binding);
  assert.deepEqual(evidence, [
    { kind: 'started', runtimeSessionId: 'native-one' },
    { kind: 'resumed', requestedRuntimeSessionId: 'native-one', runtimeSessionId: 'native-one' },
  ]);
  assert.deepEqual(f.order, ['init', 'settle', 'record', 'write', 'init', 'settle', 'record', 'write']);
  const handshake = resolveContextContinuity({
    capability: f.service.contextCapability(),
    invocationId: 'native-fixture',
    invocationOrigin: 'interactive',
    routeTopology: 'independent',
    providerPreflightAvailable: true,
  });
  assert.deepEqual(handshake.coordinate.providerCarrier, { provider: 'gemini', carrier: 'agy_stream_json' });
  assert.equal(supportsProviderContinuityPreflight(handshake), true);
});

test('a substituted native runtime cannot settle a generation or receive prompt bytes', async (t) => {
  const f = fixture(t);
  const preflight = {
    settle: async () => ({ prompt: 'final provider-confirmed prompt', promptGenerationId: 'fixture' }),
  };
  const first = [];
  for await (const message of f.service.invokeWithContinuityPreflight(preflight, { workingDirectory: f.workspace }))
    first.push(message);
  const binding = first.find((m) => m.nativeSessionBinding).nativeSessionBinding;
  f.order.length = 0;
  f.replace();
  const result = [];
  for await (const message of f.service.invokeWithContinuityPreflight(
    { settle: async () => assert.fail('foreign runtime settled') },
    { workingDirectory: f.workspace, sessionId: binding.cliSessionId, nativeSessionBinding: binding },
  ))
    result.push(message);
  assert.equal(result.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
  assert.deepEqual(f.order, ['init']);
});

test('cancellation while settling a generation delivers no Native prompt', async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    messages = [];
  for await (const message of f.service.invokeWithContinuityPreflight(
    {
      settle: async () => {
        controller.abort();
        return { prompt: 'cancelled generation', promptGenerationId: 'cancelled' };
      },
    },
    { workingDirectory: f.workspace, signal: controller.signal },
  ))
    messages.push(message);
  assert.equal(messages.at(-1).errorCode, 'AGY_CANCELLED');
  assert.deepEqual(f.order, ['init']);
});
