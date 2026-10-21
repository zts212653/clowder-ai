import { findPeerObservation } from './native-team-observation.mjs';

export function realTaskOutcome(messages, catId, marker) {
  const reply = messages.find(
    (message) =>
      message.catId === catId &&
      message.type === 'assistant' &&
      message.lifecycle?.invocationId &&
      ['completed', 'failed', 'canceled', 'interrupted'].includes(message.lifecycle.status),
  );
  if (!reply) return undefined;
  if (reply.lifecycle.status === 'completed' && String(reply.content).includes(marker))
    return { status: 'passed', messageId: reply.id };
  return {
    status: 'failed',
    messageId: reply.id,
    reason: reply.lifecycle.status === 'completed' ? 'completed_without_task_result' : reply.lifecycle.status,
  };
}

export function allA2AInvocationsDone(invocations) {
  return invocations.length >= 3 && invocations.every((invocation) => invocation.status === 'done');
}

const terminalStatuses = new Set(['completed', 'done']);

/**
 * The only messages that may explain an extra invocation's input are the immutable
 * terminal results the persisted proof itself verified. Streaming progress, partial
 * segments and every other product of the core invocations are explicitly excluded:
 * an input is a closed set of proof-verified results, never an any-match.
 */
function proofVerifiedResults(proof, byId, { leadId, peerId, peerMarker, finalMarker }) {
  const verified = new Map();
  for (const [id, catId, marker] of [
    [proof.peerMessageId, peerId, peerMarker],
    [proof.finalMessageId, leadId, finalMarker],
  ]) {
    const message = id === undefined ? undefined : byId.get(id);
    if (
      !message ||
      message.type !== 'assistant' ||
      message.catId !== catId ||
      message.lifecycle?.status !== 'completed' ||
      !String(message.content ?? '').includes(marker)
    )
      continue;
    verified.set(message.id, message);
  }
  return verified;
}

function inputRejectionReason(id, { byId, handoffIds, verifiedResults, coreInvocationIds, userMessageId }) {
  if (handoffIds.has(id)) return 'duplicate_handoff';
  if (id === userMessageId) return 'user_request_input';
  if (verifiedResults.has(id)) return undefined;
  const message = byId.get(id);
  const coreProduced =
    message &&
    (coreInvocationIds.has(message.lifecycle?.invocationId) ||
      coreInvocationIds.has(message.lifecycle?.producerInvocationId));
  return coreProduced ? 'unverified_result' : 'unexplained_input';
}

function classifyExtraInvocation(invocation, messages, byId, deps) {
  const { leadId, peerId, peerMarker, finalMarker } = deps;
  const invocationMessages = messages.filter(
    (message) => message.type === 'assistant' && message.lifecycle?.invocationId === invocation.invocationId,
  );
  const inputIds = [...new Set(invocationMessages.flatMap((message) => message.lifecycle?.inputMessageIds ?? []))];
  if (![leadId, peerId].includes(invocation.catId)) return 'unrelated_role';
  if (!terminalStatuses.has(invocation.status)) return 'not_done';
  if (inputIds.some((id) => deps.handoffIds.has(id))) return 'duplicate_handoff';
  // A message this invocation produced was admitted as another invocation's input:
  // the extra turn handed off / dispatched downstream instead of only acknowledging.
  if (messages.some((message) => message.lifecycle?.producerInvocationId === invocation.invocationId))
    return 'new_dispatch';
  if (
    invocationMessages.some(
      (message) => String(message.content).includes(peerMarker) || String(message.content).includes(finalMarker),
    )
  )
    return 'new_task_result';
  if (inputIds.length === 0) return 'missing_result_input';
  for (const id of inputIds) {
    const reason = inputRejectionReason(id, { ...deps, byId });
    if (reason) return reason;
  }
  // Publication time is the result's own terminal completedAt. startedAt/timestamp are
  // not publication evidence, so a result without completedAt can never be confirmed.
  if (!Number.isFinite(invocation.startedAt)) return 'unproven_timing';
  for (const id of inputIds) {
    const consumed = deps.verifiedResults.get(id);
    if (!Number.isFinite(consumed.lifecycle?.completedAt)) return 'unproven_publication';
    if (invocation.startedAt < consumed.lifecycle.completedAt) return 'early_confirmation';
  }
  return undefined;
}

/**
 * Classify invocations beyond the persisted lead → peer → lead proof.
 *
 * A count-only assertion cannot distinguish a harmless acknowledgement from a
 * second peer computation or an unrelated client. This validator binds every
 * extra invocation to its persisted input message and its causal timestamp.
 */
export function validateA2AInvocations(messages, invocations, { leadId, peerId, peerMarker, finalMarker, proof }) {
  if (!proof) {
    return {
      ok: false,
      acceptedConfirmations: [],
      rejectedInvocations: invocations.map((invocation) => ({
        invocationId: invocation.invocationId,
        catId: invocation.catId,
        reason: 'missing_proof',
      })),
      coreInvocationIds: [],
    };
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  // returnInvocationId is proof-verified too: on the MCP-observation path the initial
  // turn both delegates and integrates, so the return callback is a separate core turn.
  const coreInvocationIds = [
    ...new Set(
      [proof.initialInvocationId, proof.peerInvocationId, proof.finalInvocationId, proof.returnInvocationId].filter(
        Boolean,
      ),
    ),
  ];
  const core = new Set(coreInvocationIds);
  const verifiedResults = proofVerifiedResults(proof, byId, { leadId, peerId, peerMarker, finalMarker });
  // A verified terminal result is never a handoff, even when the initial invocation
  // produced it (the MCP-observation path integrates the peer reply in its own turn).
  const handoffIds = new Set(
    messages
      .filter(
        (message) =>
          message.catId === leadId &&
          producedBy(message, proof.initialInvocationId) &&
          !verifiedResults.has(message.id),
      )
      .map((message) => message.id),
  );
  const acceptedConfirmations = [];
  const rejectedInvocations = [];
  for (const invocation of invocations) {
    if (core.has(invocation.invocationId)) continue;
    const reason = classifyExtraInvocation(invocation, messages, byId, {
      leadId,
      peerId,
      peerMarker,
      finalMarker,
      handoffIds,
      verifiedResults,
      coreInvocationIds: core,
      userMessageId: proof.userMessageId,
    });
    if (reason) rejectedInvocations.push({ invocationId: invocation.invocationId, catId: invocation.catId, reason });
    else acceptedConfirmations.push(invocation.invocationId);
  }
  return {
    ok: rejectedInvocations.length === 0,
    acceptedConfirmations,
    rejectedInvocations,
    coreInvocationIds,
  };
}

const producedBy = (message, invocationId) =>
  message?.lifecycle?.invocationId === invocationId || message?.lifecycle?.producerInvocationId === invocationId;

function consumedPeerReply(response, peer, marker, byId) {
  if (response.lifecycle?.status !== 'completed' || !Number.isFinite(response.lifecycle.startedAt)) return false;
  return response.lifecycle.inputMessageIds?.some((id) => {
    const reply = byId.get(id);
    if (reply?.catId !== peer.catId || !producedBy(reply, peer.lifecycle.invocationId)) return false;
    if (!String(reply.content).includes(marker)) return false;
    const readyAt = reply.lifecycle?.producerInvocationId ? reply.timestamp : peer.lifecycle.completedAt;
    return Number.isFinite(readyAt) && response.lifecycle.startedAt >= readyAt;
  });
}

// Persisted lifecycle/causal facts are authoritative. Stream messages receive an
// ID before generation ends; array order and a model saying "received" are not proof.
export function findA2AProof(messages, { leadId, peerId, peerMarker, finalMarker, nativeToolEvents }) {
  const user = messages.find((message) => message.type === 'user');
  if (!user) return undefined;
  const lead = messages.find(
    (message) =>
      message.type === 'assistant' && message.catId === leadId && message.lifecycle?.inputMessageIds?.includes(user.id),
  );
  if (!lead?.lifecycle?.invocationId) return undefined;
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const peer of messages.filter((message) => message.catId === peerId && message.type === 'assistant')) {
    if (peer.lifecycle?.status !== 'completed' || !Number.isFinite(peer.lifecycle?.completedAt)) continue;
    if (!String(peer.content).includes(peerMarker)) continue;
    const delegation = peer.lifecycle.inputMessageIds
      ?.map((id) => byId.get(id))
      .find((message) => message?.catId === leadId && producedBy(message, lead.lifecycle.invocationId));
    if (!delegation) continue;
    const returned = messages.find(
      (message) =>
        message.type === 'assistant' &&
        message.catId === leadId &&
        message.lifecycle?.invocationId !== lead.lifecycle.invocationId &&
        consumedPeerReply(message, peer, peerMarker, byId),
    );
    if (!returned) continue;
    let observation;
    const integration = messages.find((message) => {
      if (message.type !== 'assistant' || message.catId !== leadId || !String(message.content).includes(finalMarker))
        return false;
      if (message.lifecycle?.status !== 'completed' || !Number.isFinite(message.lifecycle.startedAt)) return false;
      if (consumedPeerReply(message, peer, peerMarker, byId)) return true;
      observation = findPeerObservation(
        message,
        peer,
        peerMarker,
        byId,
        nativeToolEvents?.get(message.lifecycle.invocationId),
      );
      return Boolean(observation);
    });
    if (integration)
      return {
        userMessageId: user.id,
        initialInvocationId: lead.lifecycle.invocationId,
        delegationMessageId: delegation.id,
        peerMessageId: peer.id,
        peerInvocationId: peer.lifecycle.invocationId,
        finalMessageId: integration.id,
        finalInvocationId: integration.lifecycle.invocationId,
        returnInvocationId: returned.lifecycle.invocationId,
        ...observation,
      };
  }
  return undefined;
}
