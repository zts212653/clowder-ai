import { EXTERNAL_INSTANCE_ID } from './plugin-external-runtime-helpers.js';

export function actualInstanceId(fixtureId, callerId) {
  return fixtureId === callerId ? EXTERNAL_INSTANCE_ID : `fixture-${fixtureId}`;
}

function publishEvent(threadId, index) {
  const messageId = `fixture-event-message-${index}`;
  return {
    eventId: `fixture-event-${index}`,
    type: 'message.publish',
    envelope: {
      messageId,
      revision: 1,
      threadId,
      actor: { kind: 'plugin', id: EXTERNAL_INSTANCE_ID },
      audience: { kind: 'public' },
      occurredAt: '2026-08-26T00:00:00.000Z',
      payload: {
        provenance: {
          origin: { kind: 'plugin', instanceId: EXTERNAL_INSTANCE_ID },
          epistemicStatus: 'inference',
        },
        elements: [
          {
            elementId: `fixture-event-element-${index}`,
            kind: 'text',
            payload: { text: `fixture event ${index}` },
          },
        ],
      },
    },
  };
}

function fixtureElements(message, revision) {
  const source =
    Array.isArray(message.elements) && message.elements.length > 0
      ? message.elements.map((element, index) => ({
          elementId: element.elementId ?? `fixture-initial-${index + 1}`,
          kind: element.kind ?? 'text',
          payload: element.payload ?? { text: `fixture initial ${index + 1}` },
          ...(element.epistemicStatus === undefined ? {} : { epistemicStatus: element.epistemicStatus }),
        }))
      : [{ elementId: 'fixture-initial-1', kind: 'text', payload: { text: 'fixture initial' } }];
  const appendOps = [];
  for (let nextRevision = 2; nextRevision <= revision; nextRevision += 1) {
    const elementId = `fixture-appended-${nextRevision}`;
    source.push({
      elementId,
      kind: 'text',
      payload: { text: `fixture revision ${nextRevision}` },
      epistemicStatus: 'inference',
    });
    appendOps.push({
      operationId: `fixture-seed-${nextRevision}`,
      elementIds: [elementId],
      baseRevision: nextRevision - 1,
    });
  }
  return { elements: source, appendOps };
}

async function seedMessage(owner, behaviorCase, fixtureMessage, fixtureOwnerId, messageIdMap) {
  const callerId = behaviorCase.given.caller.pluginInstanceId;
  const pluginInstanceId = actualInstanceId(fixtureOwnerId, callerId);
  const revision = fixtureMessage.revision ?? 1;
  const { elements, appendOps } = fixtureElements(fixtureMessage, revision);
  const stored = owner.messageStore.append({
    userId: 'fixture-user',
    catId: null,
    content: 'fixture plugin message',
    mentions: [],
    timestamp: Date.now(),
    threadId: fixtureMessage.threadId,
    extra: {
      pluginMessage: {
        instanceId: pluginInstanceId,
        revision,
        provenance: {
          origin: { kind: 'plugin', instanceId: pluginInstanceId },
          epistemicStatus: 'inference',
        },
        elements,
        appendOps,
      },
    },
  });
  messageIdMap.set(fixtureMessage.messageId, stored.id);
  return stored;
}

async function seedAddressHandles(owner, behaviorCase, messageIdMap, threadIds) {
  const callerId = behaviorCase.given.caller.pluginInstanceId;
  const messages = behaviorCase.given.state.messages ?? [];
  for (const handle of Object.values(behaviorCase.given.handles)) {
    if (handle.threadId) threadIds.add(handle.threadId);
    if (handle.kind === 'subscription') continue;
    const pluginInstanceId = actualInstanceId(handle.ownerPluginInstanceId, callerId);
    const scope = {
      canSend: true,
      canSubscribe: true,
      ...(Array.isArray(behaviorCase.given.state.whisperGrantTargets)
        ? { allowedWhisperTargets: [...behaviorCase.given.state.whisperGrantTargets] }
        : {}),
    };
    if (handle.kind === 'thread_handle') {
      await owner.handleStore.put({
        handleId: handle.token,
        kind: 'thread_handle',
        pluginInstanceId,
        threadId: handle.threadId,
        userId: 'fixture-user',
        scope,
        issuedAt: 1,
      });
      continue;
    }
    if (handle.kind !== 'message_handle') continue;
    const fixtureMessage = messages.find((candidate) => candidate.messageId === handle.messageId);
    if (!fixtureMessage) throw new Error(`fixture message ${handle.messageId} is missing`);
    const stored = await seedMessage(owner, behaviorCase, fixtureMessage, handle.ownerPluginInstanceId, messageIdMap);
    const parentHandleId = `fixture-parent-${handle.token}`;
    await owner.handleStore.put({
      handleId: parentHandleId,
      kind: 'thread_handle',
      pluginInstanceId,
      threadId: handle.threadId,
      userId: 'fixture-user',
      scope,
      issuedAt: 1,
    });
    await owner.handleStore.put({
      handleId: handle.token,
      kind: 'message_handle',
      pluginInstanceId,
      threadId: handle.threadId,
      userId: 'fixture-user',
      scope,
      messageId: stored.id,
      parentHandleId,
      issuedAt: 1,
    });
  }
}

async function seedSubscriptions(owner, behaviorCase, tokenMap, threadIds, retentionCount) {
  const callerId = behaviorCase.given.caller.pluginInstanceId;
  const state = behaviorCase.given.state;
  const subscriptions = state.subscriptions ?? [];
  for (const handle of Object.values(behaviorCase.given.handles)) {
    if (handle.kind !== 'subscription') continue;
    threadIds.add(handle.threadId);
    const pluginInstanceId = actualInstanceId(handle.ownerPluginInstanceId, callerId);
    const backingHandleId = `fixture-subscription-${handle.subscriptionId}`;
    await owner.handleStore.put({
      handleId: backingHandleId,
      kind: 'thread_handle',
      pluginInstanceId,
      threadId: handle.threadId,
      userId: 'fixture-user',
      scope: { canSend: true, canSubscribe: true },
      issuedAt: 1,
    });
    const stateRecord = subscriptions.find((candidate) => candidate.subscriptionId === handle.subscriptionId);
    const cursorSequence = stateRecord?.ackedSequence ?? state.subscription?.cursorSequence ?? 0;
    await owner.cursorStore.put({
      subscriptionId: handle.subscriptionId,
      pluginInstanceId,
      handleId: backingHandleId,
      threadId: handle.threadId,
      ackedSequence: cursorSequence,
      lastDeliveredSequence: cursorSequence,
    });
  }

  const window = state.eventWindow;
  if (window) {
    const subscription = Object.values(behaviorCase.given.handles).find((handle) => handle.kind === 'subscription');
    if (!subscription) throw new Error('eventWindow fixture omitted its subscription');
    for (let index = 1; index <= window.headSequence; index += 1) {
      await owner.events.append(
        subscription.threadId,
        `fixture-event-key-${index}`,
        publishEvent(subscription.threadId, index),
        retentionCount,
      );
    }
  }

  if (behaviorCase.when.operation !== 'ack') return;
  const source = Object.values(behaviorCase.given.handles).find(
    (handle) => handle.kind === 'subscription' && handle.token === behaviorCase.when.input.ackToken,
  );
  if (!source) return;
  const sourceCursor = await owner.cursorStore.get(
    actualInstanceId(source.ownerPluginInstanceId, callerId),
    source.subscriptionId,
  );
  if (!sourceCursor) throw new Error('ack source subscription was not seeded');
  const nextSequence = sourceCursor.ackedSequence + 1;
  for (let index = 1; index <= nextSequence; index += 1) {
    await owner.events.append(
      source.threadId,
      `fixture-ack-event-key-${index}`,
      publishEvent(source.threadId, index),
      retentionCount,
    );
  }
  const read = await owner.stream.read({ pluginInstanceId: sourceCursor.pluginInstanceId }, source.subscriptionId, {
    limit: 32,
  });
  tokenMap.set(behaviorCase.when.input.ackToken, read.ackToken);
}

function translate(value, maps) {
  if (typeof value === 'string') {
    for (const map of maps) if (map.has(value)) return map.get(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => translate(item, maps));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item, maps)]));
}

export async function prepareFixture(owner, behaviorCase, retentionCount) {
  const messageIdMap = new Map();
  const tokenMap = new Map();
  const threadIds = new Set();
  await seedAddressHandles(owner, behaviorCase, messageIdMap, threadIds);
  for (const message of behaviorCase.given.state.messages ?? []) {
    threadIds.add(message.threadId);
    if (!messageIdMap.has(message.messageId)) {
      const stored = owner.messageStore.append({
        userId: 'fixture-user',
        catId: null,
        content: message.text ?? 'fixture host message',
        mentions: [],
        timestamp: Date.now(),
        threadId: message.threadId,
      });
      messageIdMap.set(message.messageId, stored.id);
    }
  }
  await seedSubscriptions(owner, behaviorCase, tokenMap, threadIds, retentionCount);
  return {
    translatedCase: {
      ...behaviorCase,
      when: {
        ...behaviorCase.when,
        input: translate(behaviorCase.when.input, [messageIdMap, tokenMap]),
      },
    },
    threadIds,
  };
}
