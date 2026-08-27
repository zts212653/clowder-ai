import { readFile } from 'node:fs/promises';

import {
  acceptSessionBinding,
  beginLocalHandshake,
  classifyFrame,
  createStdioChannel,
  prepareActivation,
} from '@clowder-ai/plugin-sdk';

const REQUEST_DEADLINE_MS = 30_000;
const RESULT_PREFIX = 'M0D_RESULT ';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const claims = {
  pluginId: requiredEnvironment('CLOWDER_PLUGIN_ID'),
  packageDigest: requiredEnvironment('CLOWDER_PACKAGE_DIGEST'),
  contractVersion: requiredEnvironment('CLOWDER_CONTRACT_VERSION'),
  wireVersion: requiredEnvironment('CLOWDER_WIRE_VERSION'),
};
const acceptanceCase = JSON.parse(await readFile(new URL('../case.json', import.meta.url), 'utf8'));
const initial = beginLocalHandshake(claims);
if (!initial.accepted) throw new Error('fixture claims failed local validation');

let handshakeState = initial.state;
let channel;
let sequence = 0;
const pending = new Map();
const inFlight = new Map();

function call(method, input, requestSnapshot) {
  sequence += 1;
  const id = `m0d-${sequence}`;
  const correlatedSnapshot =
    requestSnapshot ??
    (method === 'messaging.read'
      ? { readLimit: input.limit }
      : method === 'messaging.snapshot'
        ? { snapshotMaxItems: input.maxItems }
        : method === 'messaging.appendElements'
          ? { appendElementIds: input.elements.map((element) => element.elementId) }
          : undefined);
  const result = new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
    inFlight.set(id, {
      method,
      ...(correlatedSnapshot === undefined ? {} : { requestSnapshot: correlatedSnapshot }),
    });
  });
  void channel.send({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      meta: { deadlineUnixMs: Date.now() + REQUEST_DEADLINE_MS },
      input: structuredClone(input),
    },
  });
  return result;
}

function hostRequest(value) {
  if (
    typeof value.id !== 'string' ||
    value.params === null ||
    typeof value.params !== 'object' ||
    Array.isArray(value.params)
  ) {
    throw new Error('invalid Host request');
  }
  const input = value.params.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid Host request input');
  }
  if (value.method === 'host.lifecycle.ping') {
    return { jsonrpc: '2.0', id: value.id, result: { nonce: input.nonce } };
  }
  if (value.method === 'host.lifecycle.drain') {
    return { jsonrpc: '2.0', id: value.id, result: null };
  }
  throw new Error(`unsupported Host request ${String(value.method)}`);
}

channel = createStdioChannel(process.stdin, process.stdout, {
  onFrame: (frame) => {
    const dispatch = classifyFrame(frame, inFlight);
    if (dispatch.outcome === 'respond') return dispatch.response;
    if (dispatch.outcome === 'close') {
      throw new Error(`Host frame failed closed at ${String(dispatch.disposition)}`);
    }

    const value = frame.value;
    if ('method' in value) return hostRequest(value);
    if (typeof value.id !== 'string') throw new Error('Host response omitted request id');
    const request = pending.get(value.id);
    if (request === undefined) throw new Error('Host response has no pending call');
    pending.delete(value.id);
    inFlight.delete(value.id);
    if ('result' in value) request.resolve(value.result);
    else request.reject(value.error);
    return undefined;
  },
  onFatal: (error) => {
    process.exitCode = 1;
    process.stderr.write(`${error.message}\n`);
  },
});

const helloResult = await call('broker.hello', claims, { candidateHello: claims });
const bound = acceptSessionBinding(handshakeState, helloResult);
if (!bound.accepted || bound.state.phase !== 'bound') {
  throw new Error('Host binding failed local validation');
}
handshakeState = bound.state;

const ready = { bindingNonce: bound.state.binding.bindingNonce };
const readyResult = await call('broker.ready', ready);
if (readyResult !== null) throw new Error('broker.ready result must be null');
const activated = prepareActivation(handshakeState, ready);
if (!activated.accepted || activated.state.phase !== 'activated') {
  throw new Error('Host activation failed local validation');
}
handshakeState = activated.state;

const methodByOperation = {
  send: 'messaging.send',
  appendElements: 'messaging.appendElements',
  subscribe: 'messaging.subscribe',
  read: 'messaging.read',
  ack: 'messaging.ack',
  snapshot: 'messaging.snapshot',
};
const method = methodByOperation[acceptanceCase.when.operation];
if (method === undefined) {
  throw new Error(`unsupported canonical operation ${String(acceptanceCase.when.operation)}`);
}

try {
  const result = await call(method, acceptanceCase.when.input);
  const observation = { status: 'success', result };
  if (acceptanceCase.when.operation === 'read' && result.stale === true) {
    const snapshot = await call('messaging.snapshot', {
      subscriptionId: acceptanceCase.when.input.subscriptionId,
      maxItems: 32,
    });
    if (typeof snapshot.snapshotAckToken !== 'string') {
      throw new Error('stale read snapshot omitted its final ack token');
    }
    await call('messaging.ack', {
      subscriptionId: acceptanceCase.when.input.subscriptionId,
      ackToken: snapshot.snapshotAckToken,
    });
    const resumed = await call('messaging.read', {
      subscriptionId: acceptanceCase.when.input.subscriptionId,
      limit: acceptanceCase.when.input.limit,
    });
    observation.roundTrip = { snapshot, resumed };
  }
  process.stderr.write(`${RESULT_PREFIX}${JSON.stringify(observation)}\n`);
} catch (error) {
  process.stderr.write(`${RESULT_PREFIX}${JSON.stringify({ status: 'error', error })}\n`);
}
void handshakeState;
