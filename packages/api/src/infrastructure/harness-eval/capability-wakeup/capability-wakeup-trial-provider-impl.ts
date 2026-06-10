import type { TranscriptEvent } from '../../../domains/cats/services/session/TranscriptReader.js';
import type { SkillLoadedEvent, ToolEvent } from '../../../domains/cats/services/tool-usage/event-log-types.js';
import { getCapabilityWakeupRules } from './capability-wakeup-rules.js';
import type {
  CapabilityWakeupResolveScope,
  CapabilityWakeupSourceSelector,
  CapabilityWakeupTrialProvider,
} from './capability-wakeup-trial-provider.js';
import {
  buildCapabilityTrace,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from './eval-capability-wakeup-adapter.js';
import type { ClassifiedCapabilityWakeupTrial } from './eval-capability-wakeup-types.js';

/**
 * F192 Phase H 收尾 PR-2 — replay/reclassify provider impl (砚砚 R1 P1).
 *
 * Resolves a `CapabilityWakeupSourceSelector` to classified trials by:
 *   1. using selector.sessionIds when present, otherwise enumerating a recent runtime-session window
 *   2. resolving each sessionId → SessionRecord (threadId + catId) via sessionStore
 *   3. reading transcript/tool/skill events via real existing ports
 *   4. buildCapabilityTrace → evaluateCapabilityWakeupTrace → classifyCapabilityWakeupTrials
 *   5. filter trial.timeSpan.startMs ∈ [windowStartMs, windowEndMs)
 *
 * Constructor fail-closed (砚砚 R1 Q5): missing port → throw. NEVER silent-empty
 * (would manufacture fake misses that look like real signal).
 */

/** Port: just `get(sessionId)` — production wires `SessionChainStore`. */
export interface SessionRecordReader {
  get(
    sessionId: string,
  ):
    | Promise<{ threadId: string; catId: string; userId?: string } | null>
    | { threadId: string; catId: string; userId?: string }
    | null;
}

export interface CapabilityWakeupSessionRef {
  sessionId: string;
  threadId: string | null;
  catId: string | null;
  userId?: string;
  family?: string;
}

export interface SessionWindowEnumerator {
  listWindow(input: {
    windowStartMs: number;
    windowEndMs: number;
    ownerUserId: string;
  }): Promise<CapabilityWakeupSessionRef[]> | CapabilityWakeupSessionRef[];
}

/** Port: paginated transcript reader — production wires `TranscriptReader`. */
export interface TranscriptEventReader {
  readEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    cursor?: { eventNo: number },
    limit?: number,
  ): Promise<{ events: TranscriptEvent[]; nextCursor?: { eventNo: number }; total: number }>;
}

/** Port: thread-scoped tool event log — production wires `ToolEventLog`. */
export interface ToolEventReader {
  readByThread(threadId: string): Promise<ToolEvent[]>;
}

/** Port: session-scoped skill-load event log — production wires `SkillLoadEventLog`. */
export interface SkillLoadEventReader {
  readBySession(sessionId: string): Promise<SkillLoadedEvent[]>;
}

export interface CapabilityWakeupTrialProviderImplDeps {
  sessionStore: SessionRecordReader;
  transcriptReader: TranscriptEventReader;
  toolEventLog: ToolEventReader;
  skillLoadEventLog: SkillLoadEventReader;
  sessionEnumerator?: SessionWindowEnumerator;
  /** Override rules registry for tests; defaults to module-level static registry. */
  rulesRegistry?: typeof getCapabilityWakeupRules;
}

type CapabilityWakeupResolvedSession = {
  threadId: string;
  catId: string;
  userId?: string;
  family?: string;
};

export class CapabilityWakeupTrialProviderImpl implements CapabilityWakeupTrialProvider {
  private readonly sessionStore: SessionRecordReader;
  private readonly transcriptReader: TranscriptEventReader;
  private readonly toolEventLog: ToolEventReader;
  private readonly skillLoadEventLog: SkillLoadEventReader;
  private readonly sessionEnumerator?: SessionWindowEnumerator;
  private readonly rulesRegistry: typeof getCapabilityWakeupRules;

  constructor(deps: CapabilityWakeupTrialProviderImplDeps) {
    if (!deps.sessionStore) throw new Error('CapabilityWakeupTrialProviderImpl: missing required port sessionStore');
    if (!deps.transcriptReader)
      throw new Error('CapabilityWakeupTrialProviderImpl: missing required port transcriptReader');
    if (!deps.toolEventLog) throw new Error('CapabilityWakeupTrialProviderImpl: missing required port toolEventLog');
    if (!deps.skillLoadEventLog)
      throw new Error('CapabilityWakeupTrialProviderImpl: missing required port skillLoadEventLog');
    this.sessionStore = deps.sessionStore;
    this.transcriptReader = deps.transcriptReader;
    this.toolEventLog = deps.toolEventLog;
    this.skillLoadEventLog = deps.skillLoadEventLog;
    this.sessionEnumerator = deps.sessionEnumerator;
    this.rulesRegistry = deps.rulesRegistry ?? getCapabilityWakeupRules;
  }

  async resolve(
    selector: CapabilityWakeupSourceSelector,
    scope: CapabilityWakeupResolveScope = {},
  ): Promise<ClassifiedCapabilityWakeupTrial[]> {
    if (selector.kind !== 'capability-wakeup-trial-window') {
      throw new Error(
        `unsupported selector kind: ${selector.kind} (PR-2 only supports capability-wakeup-trial-window; trial-ids deferred to durable trial store PR)`,
      );
    }
    const rules = this.rulesRegistry({ capability: selector.capability, ruleIds: selector.ruleIds });
    if (rules.length === 0) return [];

    const sessionRefs = await this.resolveSessionRefs(selector, scope);

    // cloud R7 P2 (PR-2): dedupe sessionIds before replay — duplicate sessionId
    // would otherwise replay the same transcript and append the same classified
    // trials repeatedly → inflated trial counts → biased verdict.
    const uniqueSessionRefs = dedupeSessionRefs(sessionRefs);
    const allClassified: ClassifiedCapabilityWakeupTrial[] = [];
    for (const sessionRef of uniqueSessionRefs) {
      const sessionId = sessionRef.sessionId;
      const session = await this.resolveSessionRecord(sessionRef, scope);
      const transcriptEvents = await this.readAllTranscriptEvents(sessionId, session.threadId, session.catId);
      const toolEvents = await this.toolEventLog.readByThread(session.threadId);
      const skillLoadEvents = await this.skillLoadEventLog.readBySession(sessionId);
      const family = 'family' in session ? session.family : undefined;

      const trace = buildCapabilityTrace({
        sessionId,
        threadId: session.threadId,
        catId: session.catId,
        ...(family ? { family } : {}),
        transcriptEvents,
        toolEvents,
        skillLoadEvents,
      });

      const trials = evaluateCapabilityWakeupTrace(trace, rules);
      const classified = classifyCapabilityWakeupTrials(trace, trials);
      allClassified.push(...classified);
    }

    return allClassified.filter(
      (t) => t.timeSpan.startMs >= selector.windowStartMs && t.timeSpan.startMs < selector.windowEndMs,
    );
  }

  private async resolveSessionRecord(
    sessionRef: CapabilityWakeupSessionRef,
    scope: CapabilityWakeupResolveScope,
  ): Promise<CapabilityWakeupResolvedSession> {
    const session =
      sessionRef.threadId !== null && sessionRef.catId !== null
        ? sessionRecordFromRef(sessionRef)
        : await Promise.resolve(this.sessionStore.get(sessionRef.sessionId));
    if (!session) {
      throw new Error(`session_not_found: ${sessionRef.sessionId}`);
    }
    if (scope.ownerUserId && session.userId !== scope.ownerUserId) {
      throw new Error(`session_not_found: ${sessionRef.sessionId}`);
    }
    return session;
  }

  private async resolveSessionRefs(
    selector: CapabilityWakeupSourceSelector,
    scope: CapabilityWakeupResolveScope,
  ): Promise<CapabilityWakeupSessionRef[]> {
    if (selector.kind !== 'capability-wakeup-trial-window') return [];
    if (selector.sessionIds && selector.sessionIds.length > 0) {
      return selector.sessionIds.map((sessionId) => ({ sessionId, threadId: null, catId: null }));
    }
    if (!scope.ownerUserId) {
      throw new Error('owner_user_required: capability-wakeup window scan requires ownerUserId');
    }
    if (!this.sessionEnumerator) {
      throw new Error('sessionEnumerator is required when capability-wakeup-trial-window selector omits sessionIds');
    }
    return this.sessionEnumerator.listWindow({
      windowStartMs: selector.windowStartMs,
      windowEndMs: selector.windowEndMs,
      ownerUserId: scope.ownerUserId,
    });
  }

  /** Paginate transcript reader until exhausted. Safety cap 100 pages = 50k events. */
  private async readAllTranscriptEvents(
    sessionId: string,
    threadId: string,
    catId: string,
  ): Promise<TranscriptEvent[]> {
    const all: TranscriptEvent[] = [];
    let cursor: { eventNo: number } | undefined;
    let pages = 0;
    const MAX_PAGES = 100;
    const PAGE_SIZE = 500;
    while (pages < MAX_PAGES) {
      const result = await this.transcriptReader.readEvents(sessionId, threadId, catId, cursor, PAGE_SIZE);
      all.push(...result.events);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      pages++;
    }
    return all;
  }
}

function dedupeSessionRefs(refs: CapabilityWakeupSessionRef[]): CapabilityWakeupSessionRef[] {
  const seen = new Set<string>();
  const unique: CapabilityWakeupSessionRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.sessionId)) continue;
    seen.add(ref.sessionId);
    unique.push(ref);
  }
  return unique;
}

function sessionRecordFromRef(ref: CapabilityWakeupSessionRef): CapabilityWakeupResolvedSession {
  if (ref.threadId === null || ref.catId === null) {
    throw new Error(`session_not_found: ${ref.sessionId}`);
  }
  return {
    threadId: ref.threadId,
    catId: ref.catId,
    ...(ref.userId ? { userId: ref.userId } : {}),
    ...(ref.family ? { family: ref.family } : {}),
  };
}
