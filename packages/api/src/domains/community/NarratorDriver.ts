/**
 * F168 Phase C — C2.2: NarratorDriver
 *
 * Wakes the narrator cat (resolved via RoleResolver, never hardcoded) to produce a
 * DirectionCard TriageEntry with narrative + evidence + route recommendation.
 *
 * Design (SPIKE-1 decision — wakeCatFn path, GameNarratorDriver same mechanism):
 * - spawnNarrator() fire-and-forgets via the injected WakeCatFn to the configured
 *   narrator ops thread.
 * - The narrator cat (gemini35 by default) wakes with a structured briefing, uses MCP
 *   tools to search evidence, then POSTs to /triage-complete to submit its TriageEntry.
 * - NarratorDriver itself NEVER touches case.state (INV-1) — it is just the spawn trigger.
 *
 * Invariants enforced here:
 *   INV-1: narrator has no direct access to communityIssueStore — no path to write case.state
 *   INV-2: narrator capabilities come from RoleResolver (fail-closed if 'code'/'merge' snuck in)
 *   INV-3: spawn is idempotent per (subjectKey, sourceEventId) — in-memory dedup set
 *   INV-4/5/6: via RoleResolver.resolve('narrator') fail-closed contract
 */

import { createCatId, type RoleResolver } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';

import type { WakeCatFn } from '../cats/services/game/GameNarratorDriver.js';

export interface NarratorDriverDeps {
  /** Injected role resolver — engine's ONLY dependency on the roster (INV-6). */
  readonly roleResolver: RoleResolver;
  /**
   * Thread where the narrator cat works. Configured at deployment; this is the
   * community ops / F168 narrator thread ID (not a per-case thread).
   */
  readonly narratorThreadId: string;
  /** Proven production mechanism: GameNarratorDriver.WakeCatFn (SPIKE-1 candidate a). */
  readonly wakeCat: WakeCatFn;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

/** Parameters for a single narrator spawn invocation. */
export interface NarratorSpawnParams {
  /** Internal community issue ID — narrator needs this to call POST /triage-complete. */
  readonly caseId: string;
  /** Canonical subject key for the case (e.g. 'issue:clowder-ai#912'). */
  readonly subjectKey: string;
  /**
   * Source event ID of the trigger event (e.g. 'dispatch:{id}:{at}').
   * Used for INV-3 idempotency: same eventId → second call is a no-op.
   */
  readonly sourceEventId: string;
  /** Human-readable context for the briefing (issue title + repo + type). */
  readonly briefingContext: string;
}

/** Narrator spawn SLA — matches game narrator timeout (generous for evidence search). */
const NARRATOR_TIMEOUT_MS = 5 * 60_000; // 5 min

/**
 * NarratorDriver — thin spawn coordinator.
 *
 * Resolves the narrator role executor, builds a structured briefing, and fires
 * the WakeCatFn. Never owns case state. Idempotent by sourceEventId.
 */
export class NarratorDriver {
  readonly #deps: NarratorDriverDeps;
  /** INV-3: dedup set of eventIds spawned in this process lifetime. */
  readonly #spawnedEventIds = new Set<string>();

  constructor(deps: NarratorDriverDeps) {
    this.#deps = deps;
  }

  /**
   * Spawn the narrator for a community case event. Fire-and-forget safe: a rejection
   * from wakeCat is caught and logged (never propagates to the caller — dispatch must not
   * be blocked by narrator infrastructure failures).
   */
  async spawnNarrator(params: NarratorSpawnParams): Promise<void> {
    const { roleResolver, narratorThreadId, wakeCat, log } = this.#deps;
    const { caseId, subjectKey, sourceEventId, briefingContext } = params;

    // INV-3: idempotent by sourceEventId
    if (this.#spawnedEventIds.has(sourceEventId)) {
      log.info({ subjectKey, sourceEventId }, '[F168] NarratorDriver: dedup no-op (INV-3)');
      return;
    }

    // INV-4/5/6: resolve via RoleResolver, fail-closed on null
    const executor = roleResolver.resolve('narrator');
    if (!executor) {
      log.warn(
        { subjectKey, sourceEventId },
        '[F168] NarratorDriver: narrator role unresolved — case stays triaged (INV-5 fail-closed)',
      );
      return;
    }

    // Mark spawned BEFORE async call — ensures no duplicate fire even if await is slow
    this.#spawnedEventIds.add(sourceEventId);

    const briefing = buildNarratorBriefing({ caseId, subjectKey, sourceEventId, briefingContext });

    try {
      await wakeCat({
        threadId: narratorThreadId,
        catId: createCatId(executor.catId),
        briefing,
        timeoutMs: NARRATOR_TIMEOUT_MS,
      });

      log.info(
        { subjectKey, sourceEventId, catId: executor.catId, narratorThreadId },
        '[F168] NarratorDriver: narrator spawned ✓',
      );
    } catch (err) {
      // Fire-and-forget: wakeCat failure is logged but NEVER rethrown.
      // Case stays in triaged state — logged only; no dead-letter mechanism yet.
      log.error(
        { subjectKey, sourceEventId, catId: executor.catId, err },
        '[F168] NarratorDriver: wakeCat failed — narrator not spawned (case stays triaged)',
      );
    }
  }
}

/**
 * Build the structured briefing delivered to the narrator cat.
 *
 * The briefing is self-contained so the narrator needs no additional MCP calls just to
 * understand WHAT to triage — it can spend its MCP budget on EVIDENCE search.
 */
function buildNarratorBriefing(params: {
  caseId: string;
  subjectKey: string;
  sourceEventId: string;
  briefingContext: string;
}): string {
  const { caseId, subjectKey, sourceEventId, briefingContext } = params;
  return `[F168 社区 narrator briefing]

Case: ${subjectKey}
CaseId: ${caseId}
Event: ${sourceEventId}
Context: ${briefingContext}

你的任务（narrator 角色，capabilities: triage + route-recommend + public-reply）：
1. 用 cat_cafe_search_evidence 搜证（相关 feat / issue / PR / decisions），填 evidenceRefs
2. 用一句话说清楚这个 issue 在说什么（narrative 字段）
3. 给出路由建议（routeRecommendation: existing-thread / new-thread / decline）
4. 推荐谁接（recommendedOwnerRole，默认 case-owner）
5. 调 POST /api/community-issues/${caseId}/triage-complete 提交 TriageEntry

提交 payload 格式（JSON body，所有字段必填除非标注 optional）：
{
  "catId": "<你的 catId>",
  "verdict": "WELCOME | NEEDS-DISCUSSION | POLITELY-DECLINE",
  "questions": [
    {"id": "Q1", "result": "PASS | WARN | FAIL | UNKNOWN"},
    {"id": "Q2", "result": "..."},
    {"id": "Q3", "result": "..."},
    {"id": "Q4", "result": "..."},
    {"id": "Q5", "result": "..."}
  ],
  "authoredByRole": "narrator",
  "narrative": "<一句话摘要>",
  "evidenceRefs": ["F056", "issue:repo#123"],           // optional
  "routeRecommendation": {"kind": "existing-thread", "threadId": "..."} | {"kind": "new-thread"} | {"kind": "decline"},  // optional
  "recommendedOwnerRole": "case-owner"                   // optional
}

⚠️ 禁止：改 case.state / 写代码 / 合 PR / 开 worktree（capabilities 受限 INV-2）
⚠️ 幂等：已有同 catId entry 则不重复提交
`;
}
