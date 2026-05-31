export function transcriptEvent(eventNo, invocationId, event) {
  return {
    v: 1,
    t: Date.now() + eventNo,
    threadId: 'thread-cap',
    catId: 'gpt52',
    sessionId: 'session-cap',
    cliSessionId: 'cli-cap',
    invocationId,
    eventNo,
    event,
  };
}

export function toolEvent({ invocationId, toolName, summary = {}, turnIndex = 0, timestamp = Date.now() }) {
  return {
    invocationId,
    sessionId: 'session-cap',
    threadId: 'thread-cap',
    catId: 'gpt52',
    toolName,
    timestamp,
    turnIndex,
    status: 'success',
    summary,
  };
}

export const domain = {
  domainId: 'eval:capability-wakeup',
  displayName: 'Capability Wakeup Eval',
  systemThreadId: 'thread_eval_capability_wakeup',
  evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
  frequency: 'weekly',
  sourceAdapter: 'capability-wakeup-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F203', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
};
