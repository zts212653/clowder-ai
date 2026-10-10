import { parseFreshnessCarrierCapability } from '@/components/message-disposition-presentation';
import { writeTimeoutDiagnostics } from '@/hooks/named-message-writer';
import type { ContextHealthData, TaskProgressItem } from '@/stores/chat-types';
import { formatAgyProgressDetail } from '../system-info-visible';
import { timeoutDiagnosticsFrom } from './error-rows';
import { isLateForCommittedResponse, namedTarget } from './named-target';
import type { SystemInfoPort } from './system-info-port';
import {
  appServerStageStatus,
  governanceBlockedMessage,
  parseAppServerLifecycle,
  parseLivenessWarning,
  parseProviderCapability,
  parseProviderRecovery,
  projectContextBriefingMessage,
  stringField,
} from './system-projections';
import type { AgentEventFields } from './types';

/**
 * `system_info` updates execution status and snapshots. Response diagnostics use the exact
 * named response; actionable business cards keep their own stored identities.
 */
type StatusProjector = (parsed: Record<string, unknown>, msg: AgentEventFields, port: SystemInfoPort) => void;

/** The cat a payload is about: its own `catId`, else the event's cat. */
function payloadCatId(parsed: Record<string, unknown>, msg: AgentEventFields): string {
  return stringField(parsed, 'catId') ?? msg.catId;
}

/**
 * New invocation boundary for a cat: record the parent + turn identity and reset its task snapshot.
 * The response itself arrives by id (lifecycle snapshot or first body event) — nothing is bound here.
 */
const projectInvocationCreated: StatusProjector = (parsed, msg, port) => {
  const targetCatId = payloadCatId(parsed, msg);
  const innerInvocationId = stringField(parsed, 'invocationId');
  // The outer wrapper id is the user-turn parent; a distinct inner id is this cat's turn.
  const invocationId = msg.invocationId ?? innerInvocationId;
  const turnInvocationId = msg.turnInvocationId ?? (innerInvocationId !== invocationId ? innerInvocationId : undefined);
  if (!targetCatId || !invocationId) return;
  const now = Date.now();
  port.setCatInvocation(targetCatId, {
    invocationId,
    // An identity boundary, not a telemetry patch: explicit absence clears a cached child turn.
    turnInvocationId,
    activeRun: msg.activeRun,
    freshnessCarrierCapability: parseFreshnessCarrierCapability(parsed.freshnessCarrierCapability),
    startedAt: now,
    taskProgress: { tasks: [], lastUpdate: now, snapshotStatus: 'running', lastInvocationId: invocationId },
  });
  port.reconcileInvocationOwnership?.(targetCatId, invocationId);
};

const projectInvocationMetrics: StatusProjector = (parsed, msg, port) => {
  if (parsed.kind === 'session_started') {
    port.setCatInvocation(msg.catId, {
      sessionId: parsed.sessionId as string | undefined,
      invocationId: msg.invocationId ?? stringField(parsed, 'invocationId'),
      startedAt: Date.now(),
      taskProgress: { tasks: [], lastUpdate: 0 },
      ...(parsed.sessionSeq !== undefined ? { sessionSeq: parsed.sessionSeq as number, sessionSealed: false } : {}),
    });
  } else if (parsed.kind === 'invocation_complete') {
    port.setCatInvocation(msg.catId, {
      durationMs: parsed.durationMs as number | undefined,
      sessionId: parsed.sessionId as string | undefined,
    });
  }
};

const projectTaskProgress: StatusProjector = (parsed, msg, port) => {
  const targetCatId = payloadCatId(parsed, msg);
  // Outer invocation first so lastInvocationId matches the invocation the status panel tracks.
  const invocationId =
    msg.invocationId ?? stringField(parsed, 'invocationId') ?? port.catInvocation(targetCatId)?.invocationId;
  port.setCatInvocation(targetCatId, {
    taskProgress: {
      tasks: (parsed.tasks ?? []) as TaskProgressItem[],
      lastUpdate: Date.now(),
      snapshotStatus: 'running',
      ...(invocationId ? { lastInvocationId: invocationId } : {}),
    },
  });
};

const projectAppServerLifecycle: StatusProjector = (parsed, msg, port) => {
  const lifecycle = parseAppServerLifecycle(parsed);
  if (!lifecycle) return;
  const status = appServerStageStatus(lifecycle.stage);
  if (status) port.setCatStatus(msg.catId, status);
  port.setCatInvocation(msg.catId, { appServerLifecycle: lifecycle });
};

/** #939: read-merge-write so several capabilities coexist on one invocation snapshot. */
const projectProviderCapability: StatusProjector = (parsed, msg, port) => {
  const capability = parseProviderCapability(parsed, msg.catId);
  if (!capability.catId) return;
  const existing = port.catInvocation(capability.catId)?.providerCapabilities ?? {};
  port.setCatInvocation(capability.catId, {
    providerCapabilities: { ...existing, [capability.capability]: capability.report },
  });
};

/** F070: one actionable card per project path — a newer report replaces the previous card. */
const projectGovernanceBlocked: StatusProjector = (parsed, _msg, port) => {
  const projectPath = stringField(parsed, 'projectPath') ?? '';
  const previous = port
    .rows()
    .find((m) => m.variant === 'governance_blocked' && m.extra?.governanceBlocked?.projectPath === projectPath);
  if (previous) port.removeRow(previous.id);
  port.addRow(governanceBlockedMessage(parsed, port.newId('gov-blocked'), port.createdAt));
};

const STATUS_PROJECTORS = new Map<string, StatusProjector>([
  [
    'provider_recovery',
    (parsed, msg, port) => {
      if (isLateForCommittedResponse(msg, port.threadId, port.store())) return;
      const recovery = parseProviderRecovery(parsed, msg);
      if (!recovery) return;
      const target = namedTarget(msg, port.threadId);
      const store = port.store();
      const response = target
        ? store.getThreadState(port.threadId).messages.find((message) => message.id === target.messageId)
        : undefined;
      if (
        response &&
        (response.type !== 'assistant' ||
          response.catId !== msg.catId ||
          (response.lifecycle?.kind === 'response' &&
            response.lifecycle.invocationId !== (msg.turnInvocationId ?? msg.invocationId)))
      )
        return;
      if (target && response) {
        store.patchThreadMessage(port.threadId, target.messageId, { extra: { providerRecovery: recovery } });
      }
      if (recovery.phase === 'reconnecting') port.setCatStatus(msg.catId, 'spawning', '正在重新连接');
      if (recovery.phase === 'recovered') port.setCatStatus(msg.catId, 'streaming');
      // A failed reconnect is diagnostic evidence. Only the canonical response declares failure.
    },
  ],
  [
    'warning',
    (parsed, msg, port) => {
      if (parsed.presentation === 'transient_status' && !isLateForCommittedResponse(msg, port.threadId, port.store())) {
        port.setCatStatus(msg.catId, 'spawning', stringField(parsed, 'message'));
      }
    },
  ],
  ['invocation_created', projectInvocationCreated],
  ['invocation_metrics', projectInvocationMetrics],
  ['task_progress', projectTaskProgress],
  ['app_server_lifecycle', projectAppServerLifecycle],
  ['provider_capability', projectProviderCapability],
  ['governance_blocked', projectGovernanceBlocked],
  [
    // F148: the persisted typed card keeps its stored id and stays non-routing.
    'context_briefing',
    (parsed, _msg, port) => {
      const briefing = projectContextBriefingMessage(parsed);
      if (briefing) port.addRow(briefing);
    },
  ],
  [
    'context_health',
    (parsed, msg, port) => {
      const targetCatId = payloadCatId(parsed, msg);
      if (targetCatId) port.setCatInvocation(targetCatId, { contextHealth: parsed.health as ContextHealthData });
    },
  ],
  [
    'rate_limit',
    (parsed, msg, port) => {
      const targetCatId = payloadCatId(parsed, msg);
      if (!targetCatId) return;
      port.setCatInvocation(targetCatId, {
        rateLimit: {
          ...(typeof parsed.utilization === 'number' ? { utilization: parsed.utilization } : {}),
          ...(typeof parsed.resetsAt === 'string' ? { resetsAt: parsed.resetsAt } : {}),
        },
      });
    },
  ],
  [
    'compact_boundary',
    (parsed, msg, port) => {
      const targetCatId = payloadCatId(parsed, msg);
      if (!targetCatId) return;
      port.setCatInvocation(targetCatId, {
        compactBoundary: { ...(typeof parsed.preTokens === 'number' ? { preTokens: parsed.preTokens } : {}) },
      });
    },
  ],
  ['app_server_recovery', (_parsed, msg, port) => port.setCatStatus(msg.catId, 'spawning')],
  [
    // F118 Phase C: status + invocation snapshot.
    'liveness_warning',
    (parsed, msg, port) => {
      const warning = parseLivenessWarning(parsed);
      port.setCatStatus(msg.catId, warning.level);
      port.setCatInvocation(msg.catId, { livenessWarning: warning });
    },
  ],
  [
    // F118 AC-C3 / F117: diagnostics explain the failure of the response the event names, so they
    // are written into it (the server persists them with its terminal state too). An event that
    // names no response keeps them, open thread only, for the error row they explain.
    'timeout_diagnostics',
    (parsed, msg, port) => {
      const target = namedTarget(msg, port.threadId);
      if (target) {
        writeTimeoutDiagnostics(target, timeoutDiagnosticsFrom(parsed), port.store);
        return;
      }
      if (msg.catId) port.stashTimeoutDiagnostics?.(msg.catId, parsed);
    },
  ],
  [
    // F210-H3: one folded progress line in the cat status detail, never a per-step bubble.
    'agy_trajectory_progress',
    (parsed, msg, port) => {
      if (msg.catId) port.setCatStatus(msg.catId, 'streaming', formatAgyProgressDetail(parsed));
    },
  ],
]);

/** Returns true when `parsed.type` is a status-only subtype (then it has been projected). */
export function projectStatusSystemInfo(
  parsed: Record<string, unknown>,
  msg: AgentEventFields,
  port: SystemInfoPort,
): boolean {
  const project = typeof parsed.type === 'string' ? STATUS_PROJECTORS.get(parsed.type) : undefined;
  if (!project) return false;
  project(parsed, msg, port);
  return true;
}
