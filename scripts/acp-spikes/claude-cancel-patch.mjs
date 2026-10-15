export function patchClaudeQueuedCancel(input) {
  let text = input.replaceAll('\r\n', '\n');
  text = 'import { hasNativeQueuedCancel, interruptIncludingQueued } from "./ClowderNativeCancel.js";\n' + text;
  text = text.replace(
    '  msgLifecycleV1?: boolean;',
    '  msgLifecycleV1?: boolean;\n  clowderCancelQueued?: boolean;\n  clowderCancelPending?: boolean;\n  clowderCancelPromise?: Promise<void>;\n  clowderPendingNext?: Set<string>;',
  );
  const initAnchor = '                if (message.capabilities?.includes("msg_lifecycle_v1")) {';
  if (!text.includes(initAnchor)) throw new Error('Native cancellation capability anchor missing');
  text = text.replace(
    initAnchor,
    '                if (message.capabilities?.includes("interrupt_cancel_queued_v1")) session.clowderCancelQueued = true;\n' +
      initAnchor,
  );
  const steerAnchor = '    const userMessage = promptToClaude(promptRequest);';
  if (!text.includes(steerAnchor)) throw new Error('Next admission anchor missing');
  text = text.replace(
    steerAnchor,
    `    if (params._meta?.steering?.delivery === "next" && (session.cancelled || session.clowderCancelPending))
      throw new Error("notice_cancelled");
    if (params._meta?.steering?.delivery === "next" &&
        (!session.clowderCancelQueued || !hasNativeQueuedCancel(session.query)))
      throw new Error("next_requires_native_queued_cancel");
${steerAnchor}`,
  );
  text = text.replace(
    '    userMessage.uuid = steeredUuid;',
    `    userMessage.uuid = steeredUuid;
    if (params._meta?.steering?.delivery === "next") (session.clowderPendingNext ??= new Set()).add(steeredUuid);`,
  );
  text = text.replaceAll(
    '    session.input.push(userMessage);',
    '    if (session.clowderCancelPending || session.queryClosed) throw new Error("native_cancel_pending");\n    session.input.push(userMessage);',
  );
  text = text.replace(
    '    const userMessage = promptToClaude(params);',
    '    if (session.clowderCancelPending) throw new Error("native_cancel_pending");\n    const userMessage = promptToClaude(params);',
  );
  text = text.replace(
    '    session.turnQueue.push(turn);',
    '    if (session.clowderCancelPending || session.queryClosed) throw new Error("native_cancel_pending");\n    session.turnQueue.push(turn);',
  );
  text = text.replace(
    '    session.cancelled = true;',
    '    session.clowderCancelPending = true;\n    session.cancelled = true;',
  );
  const cancelMethod = '  async cancel(params: CancelNotification): Promise<void> {';
  if (!text.includes(cancelMethod)) throw new Error('Cancel single-flight anchor missing');
  text = text.replace(
    cancelMethod,
    `  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) return;
    if (session.clowderCancelPromise) return session.clowderCancelPromise;
    if (session.queryClosed) return;
    // Close admission synchronously; all concurrent callers share this native operation.
    session.clowderCancelPending = true;
    const operation = Promise.resolve().then(() => this.clowderCancelOnce(params));
    session.clowderCancelPromise = operation;
    try { await operation; }
    finally {
      if (session.clowderCancelPromise === operation) {
        session.clowderCancelPromise = undefined;
        session.clowderCancelPending = Boolean(session.queryClosed);
      }
    }
  }

  private async clowderCancelOnce(params: CancelNotification): Promise<void> {`,
  );
  const lifecycleAnchor = '        if (\n          session.emitRawSDKMessages &&';
  if (!text.includes(lifecycleAnchor)) throw new Error('Native input acknowledgement anchor missing');
  text = text.replace(
    lifecycleAnchor,
    `        // Latch native arrival before publishing a callback which can race cancellation.
        const clowderLifecycle = message as unknown as { type: string; command_uuid?: string; state?: string };
        if (clowderLifecycle.type === "command_lifecycle" && typeof clowderLifecycle.command_uuid === "string" &&
            ["queued", "started", "completed", "discarded", "cancelled"].includes(clowderLifecycle.state ?? ""))
          session.clowderPendingNext?.delete(clowderLifecycle.command_uuid);
${lifecycleAnchor}`,
  );
  const cancelAnchor = '    const receipt = await session.query.interrupt();';
  if (!text.includes(cancelAnchor)) throw new Error('Native cancellation call anchor missing');
  text = text.replace(
    cancelAnchor,
    `    if (session.clowderPendingNext?.size) {
      // No native acknowledgement: an input may still be in the SDK pump.
      // Closing fences that ingress; never infer withdrawal from an empty native queue.
      const cancelledActive = session.activeTurn;
      const knownUsage = sessionUsage(session);
      this.closeQueryStream(session);
      disarmForceCancel(session);
      for (const turn of session.turnQueue ?? []) if (!turn.settled) {
        this.finishFileChangeAudit(session, turn, "cancelled");
        turn.settled = true;
        turn.resolve({ stopReason: "cancelled", ...(turn === cancelledActive ? { usage: knownUsage } : {}) });
      }
      session.turnQueue = [];
      session.activeTurn = null;
      session.emittedAssistantText = false;
      return;
    }
    const receipt = await interruptIncludingQueued(session.query,
      session.clowderCancelQueued === true && hasNativeQueuedCancel(session.query))
      .catch(error => { this.closeQueryStream(session); throw error; });`,
  );
  return text;
}
