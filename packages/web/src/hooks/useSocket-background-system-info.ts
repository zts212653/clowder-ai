import type { TaskProgressItem } from '@/stores/chat-types';
import type {
  BackgroundAgentMessage,
  BackgroundStreamRef,
  HandleBackgroundMessageOptions,
} from './useSocket-background.types';

interface SystemInfoConsumeResult {
  consumed: boolean;
  content: string;
  variant: 'info' | 'a2a_followup';
}

function recoverBackgroundStreamingMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const streamKey = `${msg.threadId}::${msg.catId}`;
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const message = threadMessages[i];
    if (message.type === 'assistant' && message.catId === msg.catId && message.isStreaming) {
      options.bgStreamRefs.set(streamKey, { id: message.id, threadId: msg.threadId, catId: msg.catId });
      if (msg.metadata) {
        options.store.setThreadMessageMetadata(msg.threadId, message.id, msg.metadata);
      }
      return message.id;
    }
  }
  return undefined;
}

export function consumeBackgroundSystemInfo(
  msg: BackgroundAgentMessage,
  existingRef: BackgroundStreamRef | undefined,
  options: HandleBackgroundMessageOptions,
): SystemInfoConsumeResult {
  let sysContent = msg.content ?? '';
  let sysVariant: 'info' | 'a2a_followup' = 'info';
  let consumed = false;

  try {
    const parsed = JSON.parse(sysContent);
    if (parsed?.type === 'invocation_created') {
      const targetCatId = parsed.catId ?? msg.catId;
      const invocationId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
      // #586: Clear stale finalizedBgRef so previous invocation's finalized bubble
      // can't be overwritten by the next invocation's callback.
      const bgStreamKey = `${msg.threadId}::${targetCatId}`;
      options.finalizedBgRefs.delete(bgStreamKey);
      if (targetCatId && invocationId) {
        options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
          invocationId,
          startedAt: Date.now(),
          taskProgress: {
            tasks: [],
            lastUpdate: Date.now(),
            snapshotStatus: 'running',
            lastInvocationId: invocationId,
          },
        });
        const targetId = existingRef?.id ?? recoverBackgroundStreamingMessage(msg, options);
        if (targetId) {
          options.store.setThreadMessageStreamInvocation(msg.threadId, targetId, invocationId);
        }
        consumed = true;
      }
    } else if (parsed?.type === 'invocation_metrics') {
      if (parsed.kind === 'session_started') {
        options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
          sessionId: parsed.sessionId,
          invocationId: parsed.invocationId,
          startedAt: Date.now(),
          taskProgress: { tasks: [], lastUpdate: 0 },
          ...(parsed.sessionSeq !== undefined ? { sessionSeq: parsed.sessionSeq, sessionSealed: false } : {}),
        });
      } else if (parsed.kind === 'invocation_complete') {
        options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
          durationMs: parsed.durationMs,
          sessionId: parsed.sessionId,
        });
      }
      consumed = true;
    } else if (parsed?.type === 'invocation_usage') {
      options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
        usage: parsed.usage,
      });
      if (existingRef?.id) {
        options.store.setThreadMessageUsage(msg.threadId, existingRef.id, parsed.usage);
      }
      consumed = true;
    } else if (parsed?.type === 'context_health') {
      const targetCatId = parsed.catId ?? msg.catId;
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        contextHealth: parsed.health,
      });
      consumed = true;
    } else if (parsed?.type === 'rate_limit') {
      const targetCatId = parsed.catId ?? msg.catId;
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        rateLimit: {
          ...(typeof parsed.utilization === 'number' ? { utilization: parsed.utilization } : {}),
          ...(typeof parsed.resetsAt === 'string' ? { resetsAt: parsed.resetsAt } : {}),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'compact_boundary') {
      const targetCatId = parsed.catId ?? msg.catId;
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        compactBoundary: {
          ...(typeof parsed.preTokens === 'number' ? { preTokens: parsed.preTokens } : {}),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'task_progress') {
      const targetCatId = parsed.catId ?? msg.catId;
      const currentInvocationId =
        typeof parsed.invocationId === 'string'
          ? parsed.invocationId
          : options.store.getThreadState(msg.threadId).catInvocations[targetCatId]?.invocationId;
      const tasks = (parsed.tasks ?? []) as TaskProgressItem[];
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        taskProgress: {
          tasks,
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
          ...(currentInvocationId ? { lastInvocationId: currentInvocationId } : {}),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'web_search') {
      // F045: web_search tool event (privacy: no query, count only) — render as ToolEvent, not raw JSON
      const count = typeof parsed.count === 'number' ? parsed.count : 1;
      let targetId = existingRef?.id;
      if (!targetId) {
        targetId = recoverBackgroundStreamingMessage(msg, options);
      }
      if (!targetId) {
        // Create placeholder assistant bubble if needed (mirrors thinking path)
        const streamKey = `${msg.threadId}::${msg.catId}`;
        targetId = `bg-web-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
        const invocationId = options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.invocationId;
        options.bgStreamRefs.set(streamKey, { id: targetId, threadId: msg.threadId, catId: msg.catId });
        options.store.addMessageToThread(msg.threadId, {
          id: targetId,
          type: 'assistant',
          catId: msg.catId,
          content: '',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
          timestamp: msg.timestamp,
          isStreaming: true,
          origin: 'stream',
        });
      }

      options.store.appendToolEventToThread(msg.threadId, targetId, {
        id: `bg-web-search-${msg.timestamp}-${options.nextBgSeq()}`,
        type: 'tool_use',
        label: `${msg.catId} → web_search${count > 1 ? ` x${count}` : ''}`,
        timestamp: msg.timestamp,
      });
      consumed = true;
    } else if (parsed?.type === 'rich_block') {
      // F22: Append rich block — mirror foreground path (useAgentMessages.ts)
      let targetId: string | undefined;

      // Prefer messageId correlation from callback post-message path
      if (parsed.messageId) {
        const found = options.store
          .getThreadState(msg.threadId)
          .messages.find((m: { id: string }) => m.id === parsed.messageId);
        if (found) targetId = found.id;
      }

      // Fallback: most recent callback message from this cat
      if (!targetId) {
        const threadMessages = options.store.getThreadState(msg.threadId).messages;
        for (let i = threadMessages.length - 1; i >= 0; i--) {
          const m = threadMessages[i];
          if (m.type !== 'assistant' || m.catId !== msg.catId) continue;
          if (m.origin === 'stream' && m.isStreaming) break;
          if (m.origin === 'callback') {
            targetId = m.id;
            break;
          }
        }
      }

      // Final fallback: recover active stream bubble or create placeholder
      if (!targetId) {
        targetId = existingRef?.id ?? recoverBackgroundStreamingMessage(msg, options);
      }
      if (!targetId) {
        // No existing bubble — create placeholder (mirrors foreground ensureActiveAssistantMessage)
        const streamKey = `${msg.threadId}::${msg.catId}`;
        targetId = `bg-rich-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
        const invocationId = options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.invocationId;
        options.bgStreamRefs.set(streamKey, { id: targetId, threadId: msg.threadId, catId: msg.catId });
        options.store.addMessageToThread(msg.threadId, {
          id: targetId,
          type: 'assistant',
          catId: msg.catId,
          content: '',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
          timestamp: msg.timestamp,
          isStreaming: true,
          origin: 'stream',
        });
      }

      if (parsed.block) {
        options.store.appendRichBlockToThread(msg.threadId, targetId, parsed.block);
      }
      consumed = true;
    } else if (parsed?.type === 'liveness_warning') {
      // F118 Phase C: Liveness warning — update cat status + invocation snapshot (mirror foreground)
      const level = parsed.level as 'alive_but_silent' | 'suspected_stall';
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, level);
      options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
        livenessWarning: {
          level,
          state: parsed.state as 'active' | 'busy-silent' | 'idle-silent' | 'dead',
          silenceDurationMs: parsed.silenceDurationMs as number,
          cpuTimeMs: typeof parsed.cpuTimeMs === 'number' ? parsed.cpuTimeMs : undefined,
          processAlive: parsed.processAlive as boolean,
          receivedAt: Date.now(),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'timeout_diagnostics') {
      // F118 AC-C3: Timeout diagnostics — consume silently in background threads.
      // Foreground uses pendingTimeoutDiagRef (React ref) to attach to error messages;
      // background threads don't have that mechanism, so we just suppress the raw JSON.
      consumed = true;
    } else if (parsed?.type === 'warning') {
      // F045: item-level warning — render as readable system message (mirror foreground)
      const warningText = typeof parsed.message === 'string' ? parsed.message : '';
      sysContent = warningText ? `⚠️ ${warningText}` : '⚠️ Warning';
      sysVariant = 'info';
    } else if (parsed?.type === 'governance_blocked') {
      const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath : '';
      const reasonKind = (parsed.reasonKind as string) ?? 'needs_bootstrap';
      const invId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
      const threadMessages = options.store.getThreadState(msg.threadId).messages;
      const existing = threadMessages.find(
        (m: { variant?: string; extra?: { governanceBlocked?: { projectPath?: string } } }) =>
          m.variant === 'governance_blocked' && m.extra?.governanceBlocked?.projectPath === projectPath,
      );
      if (existing) {
        options.store.removeThreadMessage(msg.threadId, existing.id);
      }
      options.store.addMessageToThread(msg.threadId, {
        id: `gov-blocked-${msg.timestamp}-${options.nextBgSeq()}`,
        type: 'system',
        variant: 'governance_blocked',
        content: `项目 ${projectPath} ${reasonKind === 'needs_bootstrap' ? '尚未初始化治理' : '治理状态异常'}`,
        timestamp: msg.timestamp,
        extra: {
          governanceBlocked: {
            projectPath,
            reasonKind: reasonKind as 'needs_bootstrap' | 'needs_confirmation' | 'files_missing',
            invocationId: invId,
          },
        },
      });
      consumed = true;
    } else if (parsed?.type === 'strategy_allow_compress' || parsed?.type === 'resume_failure_stats') {
      // Internal telemetry — suppress to avoid raw JSON bubbles in background threads
      consumed = true;
    } else if (parsed?.type === 'session_seal_requested') {
      if (parsed.catId) {
        options.store.setThreadCatInvocation(msg.threadId, parsed.catId, {
          sessionSeq: parsed.sessionSeq,
          sessionSealed: true,
        });
        const pct = parsed.healthSnapshot?.fillRatio ? Math.round(parsed.healthSnapshot.fillRatio * 100) : '?';
        sysContent = `${parsed.catId} 的会话 #${parsed.sessionSeq} 已封存（上下文 ${pct}%），下次调用将自动创建新会话`;
      }
    } else if (parsed?.type === 'a2a_followup_available') {
      const mentions = parsed.mentions as Array<{ catId: string; mentionedBy: string }>;
      if (Array.isArray(mentions) && mentions.length > 0) {
        sysContent = mentions.map((m) => `${m.mentionedBy} @了 ${m.catId}`).join('、');
        sysVariant = 'a2a_followup';
      }
    } else if (parsed?.type === 'mode_switch_proposal') {
      const by = parsed.proposedBy ?? '猫猫';
      sysContent = `${by} 提议切换到 ${parsed.proposedMode} 模式。`;
    } else if (parsed?.type === 'silent_completion') {
      // Bugfix: silent-exit — cat ran tools but produced no text response
      const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
      sysContent = detail || `${msg.catId} completed without a text response.`;
    } else if (parsed?.type === 'invocation_preempted') {
      // Bugfix: silent-exit — invocation was superseded by a newer request
      sysContent = 'This response was superseded by a newer request.';
    } else if (parsed?.type === 'thinking') {
      // F045: Embed thinking into the assistant bubble (matches foreground path)
      const thinkingText = parsed.text ?? '';
      if (thinkingText) {
        let targetId = existingRef?.id;
        if (!targetId) {
          targetId = recoverBackgroundStreamingMessage(msg, options);
        }
        if (!targetId) {
          // Thinking arrived before any text/tool chunk — create placeholder assistant bubble
          const streamKey = `${msg.threadId}::${msg.catId}`;
          targetId = `bg-think-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
          const invocationId = options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.invocationId;
          options.bgStreamRefs.set(streamKey, { id: targetId, threadId: msg.threadId, catId: msg.catId });
          options.store.addMessageToThread(msg.threadId, {
            id: targetId,
            type: 'assistant',
            catId: msg.catId,
            content: '',
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
            timestamp: msg.timestamp,
            isStreaming: true,
            origin: 'stream',
          });
        }
        options.store.setThreadMessageThinking(msg.threadId, targetId, thinkingText);
      }
      consumed = true;
    }
  } catch {
    // Not JSON; keep original content as user-facing system info.
  }

  return { consumed, content: sysContent, variant: sysVariant };
}
