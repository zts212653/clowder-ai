const CONTEXT_TOOLS = new Set([
  'mcp:cat-cafe-collab/cat_cafe_get_thread_context',
  'mcp__cat-cafe-collab__cat_cafe_get_thread_context',
]);

function contextSnapshot(detail) {
  if (typeof detail !== 'string') return undefined;
  try {
    const value = JSON.parse(detail.trim().startsWith('{') ? detail : detail.slice(detail.indexOf('\n') + 1));
    return Array.isArray(value.messages) ? value.messages : undefined;
  } catch {
    return undefined;
  }
}

// A lead can read the peer's real reply using MCP before its initial turn ends.
// Pair native tool events and verify the actual snapshot, not model narration.
export function findPeerObservation(response, peer, marker, byId, nativeEvents) {
  const events = nativeEvents ?? response.toolEvents ?? [];
  const uses = new Map(
    events
      .filter((event) => event.type === 'tool_use' && CONTEXT_TOOLS.has(event.toolName) && event.toolUseId)
      .map((event) => [event.toolUseId, event]),
  );
  for (const result of events) {
    const use = uses.get(result.toolUseId);
    if (result.type !== 'tool_result' || result.status !== 'ok' || !use) continue;
    if (
      !Number.isFinite(result.timestamp) ||
      !Number.isFinite(use.timestamp) ||
      result.timestamp < use.timestamp ||
      !Number.isFinite(response.lifecycle?.completedAt) ||
      result.timestamp > response.lifecycle.completedAt
    )
      continue;
    const snapshot = contextSnapshot(result.detail);
    const observed = snapshot?.find((entry) => {
      const actual = byId.get(entry.id);
      return (
        actual?.catId === peer.catId &&
        (actual.lifecycle?.invocationId === peer.lifecycle.invocationId ||
          actual.lifecycle?.producerInvocationId === peer.lifecycle.invocationId) &&
        typeof entry.content === 'string' &&
        entry.content.includes(marker) &&
        Number.isFinite(actual.timestamp) &&
        result.timestamp >= actual.timestamp
      );
    });
    if (observed) return { observationToolUseId: result.toolUseId, observedMessageId: observed.id };
  }
  return undefined;
}
