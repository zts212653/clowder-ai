/**
 * SessionSealer — F24 Phase B+C
 * Manages session lifecycle transitions: active → sealing → sealed.
 *
 * Two methods:
 * - requestSeal(): fast path — CAS status change + clear active pointer
 * - finalize(): slow path — transcript JSONL flush + digest + mark sealed
 *
 * Invoke pipeline is responsible for detecting thresholds and calling requestSeal().
 * SessionSealer is responsible for the lifecycle state machine.
 */

import type { CatId, SealResult, SessionStatus } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { extractRecentArtifacts } from '../agents/routing/artifact-tracking.js';
import { AuditEventTypes, getEventAuditLog } from '../orchestration/EventAuditLog.js';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import type { ISummaryStore } from '../stores/ports/SummaryStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import { buildThreadMemory } from './buildThreadMemory.js';
import { extractDecisionSignals } from './extractDecisionSignals.js';
import { generateHandoffDigest } from './HandoffDigestGenerator.js';
import { formatEventsChat, formatEventsHandoff } from './TranscriptFormatter.js';
import type { TranscriptReader } from './TranscriptReader.js';
import type { ExtractiveDigestV1, TranscriptWriter } from './TranscriptWriter.js';

const log = createModuleLogger('session-sealer');
const FINALIZE_TIMEOUT_MS = 30_000;

export type SealReason = 'threshold' | 'manual' | 'error' | (string & {});

/**
 * F065 Phase C: Handoff digest configuration.
 * Injectable functions for testability and per-thread resolution.
 */
export interface HandoffConfig {
  getBootstrapDepth: (catId: string) => 'extractive' | 'generative';
  resolveProfile: (threadId: string, catId: string) => Promise<{ apiKey: string; baseUrl: string } | null>;
  fetchFn?: typeof fetch;
}

export interface ISessionSealer {
  /**
   * Request seal of a session. Idempotent: returns accepted=false if already sealing/sealed.
   * Fast path: only changes status + clears active pointer.
   */
  requestSeal(args: { sessionId: string; reason: SealReason }): Promise<SealResult>;

  /**
   * Finalize a sealing session: write transcript, generate digest, mark sealed.
   * Phase B stub: just transitions sealing → sealed.
   * Phase C will add transcript + digest logic.
   */
  finalize(args: { sessionId: string }): Promise<void>;

  /**
   * F118 Hardening: Reconcile sessions stuck in 'sealing' state for a specific cat/thread.
   * Force-seals any session that has been in 'sealing' longer than maxAgeMs.
   * Returns count of reconciled sessions.
   */
  reconcileStuck(catId: string, threadId: string, maxAgeMs?: number): Promise<number>;

  /**
   * F118 Hardening: Global reaper — reconcile ALL sessions stuck in 'sealing' across
   * all cats/threads. Runs at startup and periodically to catch orphaned sealing sessions
   * that would never be visited by per-invoke lazy scanning.
   * Returns total count of reconciled sessions.
   */
  reconcileAllStuck(maxAgeMs?: number): Promise<number>;
}

/**
 * In-memory SessionSealer implementation.
 * Uses ISessionChainStore for all state mutations.
 * Optionally uses TranscriptWriter for Phase C transcript flush.
 * F065 Phase B: Optionally updates ThreadMemory on seal.
 * F065 Phase C: Optionally generates handoff digest via Haiku.
 */
export class SessionSealer implements ISessionSealer {
  constructor(
    private readonly store: ISessionChainStore,
    private readonly transcriptWriter?: TranscriptWriter,
    private readonly threadStore?: IThreadStore,
    private readonly transcriptReader?: TranscriptReader,
    private readonly getMaxPromptTokens?: (catId: CatId) => number,
    private readonly handoffConfig?: HandoffConfig,
    private readonly summaryStore?: ISummaryStore,
  ) {}

  async requestSeal(args: { sessionId: string; reason: SealReason }): Promise<SealResult> {
    const record = await this.store.get(args.sessionId);
    if (!record) {
      return { accepted: false, status: 'sealed' };
    }

    // CAS: only active sessions can be sealed
    // Snapshot status before mutation (memory store returns live reference)
    const currentStatus: SessionStatus = record.status;
    if (currentStatus !== 'active') {
      return { accepted: false, status: currentStatus };
    }

    // Transition active → sealing
    const now = Date.now();
    const updated = await this.store.update(args.sessionId, {
      status: 'sealing',
      sealReason: args.reason,
      updatedAt: now,
    });

    if (!updated || updated.status !== 'sealing') {
      // Race condition: another caller got there first
      return { accepted: false, status: updated?.status ?? 'sealed' };
    }

    log.info(
      { sessionId: args.sessionId, catId: record.catId, threadId: record.threadId, reason: args.reason },
      'session seal requested',
    );
    getEventAuditLog()
      .append({
        type: AuditEventTypes.SEAL_REQUESTED,
        threadId: record.threadId,
        data: {
          sessionId: args.sessionId,
          catId: record.catId,
          cliSessionId: record.cliSessionId,
          reason: args.reason,
          seq: record.seq,
        },
      })
      .catch(() => {});

    return {
      accepted: true,
      status: 'sealing',
      sessionId: args.sessionId,
    };
  }

  async finalize(args: { sessionId: string }): Promise<void> {
    const record = await this.store.get(args.sessionId);
    if (!record) return;

    // Only finalize sessions in sealing state
    if (record.status !== 'sealing') return;

    const now = Date.now();

    let finalizeClean = false;
    try {
      finalizeClean = await withTimeout(this.doFinalize(record, now), FINALIZE_TIMEOUT_MS);
    } catch (err) {
      // finalizeClean stays false — timeout or unexpected throw.
      getEventAuditLog()
        .append({
          type: AuditEventTypes.SEAL_FINALIZE_FAILED,
          threadId: record.threadId,
          data: {
            sessionId: args.sessionId,
            catId: record.catId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        .catch(() => {});
    }

    // Always attempt terminal transition — even if doFinalize failed/timed out.
    // A sealed session with missing transcript is recoverable; a stuck sealing session is not.
    try {
      await this.store.update(args.sessionId, {
        status: 'sealed',
        sealedAt: now,
        updatedAt: now,
      });
      log.info(
        {
          sessionId: args.sessionId,
          catId: record.catId,
          threadId: record.threadId,
          reason: record.sealReason,
          partial: !finalizeClean,
        },
        finalizeClean
          ? 'session seal finalized'
          : 'session seal finalized (partial — transcript/digest may be missing)',
      );
      if (finalizeClean) {
        getEventAuditLog()
          .append({
            type: AuditEventTypes.SEAL_FINALIZED,
            threadId: record.threadId,
            data: {
              sessionId: args.sessionId,
              catId: record.catId,
              cliSessionId: record.cliSessionId,
              reason: record.sealReason,
              seq: record.seq,
              sealedAt: now,
            },
          })
          .catch(() => {});
      }
    } catch (err) {
      getEventAuditLog()
        .append({
          type: AuditEventTypes.SEAL_FINALIZE_FAILED,
          threadId: record.threadId,
          data: {
            sessionId: args.sessionId,
            phase: 'terminal_update',
            error: err instanceof Error ? err.message : String(err),
          },
        })
        .catch(() => {});
    }
  }

  /**
   * Reconcile sessions stuck in 'sealing' state.
   * Scans all sessions for the given cat/thread and force-seals any that have been
   * in 'sealing' longer than maxAgeMs. Returns count of reconciled sessions.
   */
  async reconcileStuck(catId: string, threadId: string, maxAgeMs = 5 * 60_000): Promise<number> {
    const sessions = await this.store.getChain(catId as CatId, threadId);
    const now = Date.now();
    let count = 0;
    for (const s of sessions) {
      if (s.status === 'sealing' && now - (s.updatedAt ?? s.createdAt) > maxAgeMs) {
        await this.store.update(s.id, {
          status: 'sealed',
          sealReason: 'reconcile_stuck',
          sealedAt: now,
          updatedAt: now,
        });
        log.info(
          {
            sessionId: s.id,
            catId: s.catId,
            threadId: s.threadId,
            reason: 'reconcile_stuck',
            stuckDurationMs: now - (s.updatedAt ?? s.createdAt),
          },
          'session force-sealed by stuck reaper',
        );
        getEventAuditLog()
          .append({
            type: AuditEventTypes.SEAL_FINALIZE_FAILED,
            threadId: s.threadId,
            data: {
              sessionId: s.id,
              catId: s.catId,
              phase: 'reconcile_stuck',
              stuckDurationMs: now - (s.updatedAt ?? s.createdAt),
            },
          })
          .catch(() => {});
        count++;
      }
    }
    return count;
  }

  async reconcileAllStuck(maxAgeMs = 5 * 60_000): Promise<number> {
    const sealingIds = await this.store.listSealingSessions();
    if (sealingIds.length === 0) return 0;

    const now = Date.now();
    let count = 0;
    for (const id of sealingIds) {
      const s = await this.store.get(id);
      if (!s || s.status !== 'sealing') continue;
      if (now - (s.updatedAt ?? s.createdAt) > maxAgeMs) {
        await this.store.update(s.id, {
          status: 'sealed',
          sealReason: 'global_reaper',
          sealedAt: now,
          updatedAt: now,
        });
        log.info(
          {
            sessionId: s.id,
            catId: s.catId,
            threadId: s.threadId,
            reason: 'global_reaper',
            stuckDurationMs: now - (s.updatedAt ?? s.createdAt),
          },
          'session force-sealed by global reaper',
        );
        getEventAuditLog()
          .append({
            type: AuditEventTypes.SEAL_FINALIZE_FAILED,
            threadId: s.threadId,
            data: {
              sessionId: s.id,
              catId: s.catId,
              phase: 'global_reaper',
              stuckDurationMs: now - (s.updatedAt ?? s.createdAt),
            },
          })
          .catch(() => {});
        count++;
      }
    }
    return count;
  }

  /**
   * Returns true if all best-effort steps succeeded, false if any threw.
   * Callers use this to decide whether to emit SEAL_FINALIZED (clean) or log partial.
   */
  private async doFinalize(
    record: { id: string; threadId: string; catId: string; cliSessionId: string; seq: number; createdAt: number },
    now: number,
  ): Promise<boolean> {
    let clean = true;

    // Phase C: Flush transcript + index + extractive digest
    if (this.transcriptWriter) {
      try {
        await this.transcriptWriter.flush(
          {
            sessionId: record.id,
            threadId: record.threadId,
            catId: record.catId,
            cliSessionId: record.cliSessionId,
            seq: record.seq,
          },
          { createdAt: record.createdAt, sealedAt: now },
        );
      } catch {
        clean = false;
        // best-effort: transcript flush failure doesn't prevent sealing
      }
    }

    // F065 Phase B: Update thread memory after successful digest write
    if (this.threadStore && this.transcriptReader) {
      try {
        const digest = await this.transcriptReader.readDigest(record.id, record.threadId, record.catId);
        if (digest) {
          const existingMemory = await this.threadStore.getThreadMemory(record.threadId);
          // KD-5 dynamic cap: min(3000, floor(maxPromptTokens * 0.03)), floor 1200
          const maxPrompt = this.getMaxPromptTokens?.(record.catId as CatId) ?? 180000;
          const maxTokens = Math.max(1200, Math.min(3000, Math.floor(maxPrompt * 0.03)));

          // VG-3: Extract decision signals from transcript + summary (best-effort)
          const signals = await this.extractSignals(record);

          const fileArtifacts = extractRecentArtifacts({
            filesTouched: (digest as unknown as ExtractiveDigestV1).filesTouched ?? [],
            prTasks: [],
            catId: record.catId,
          });

          const updated = buildThreadMemory(
            existingMemory,
            digest as unknown as ExtractiveDigestV1,
            maxTokens,
            signals,
            fileArtifacts.length > 0 ? fileArtifacts : undefined,
          );
          await this.threadStore.updateThreadMemory(record.threadId, updated);
        }
      } catch {
        clean = false;
        // best-effort: thread memory update failure doesn't prevent sealing
      }
    }

    // F065 Phase C: Generate handoff digest (best-effort, after ThreadMemory)
    if (this.handoffConfig && this.transcriptReader) {
      try {
        const depth = this.handoffConfig.getBootstrapDepth(record.catId);
        if (depth === 'generative') {
          const profile = await this.handoffConfig.resolveProfile(record.threadId, record.catId);
          if (profile?.apiKey) {
            const allEvents = await this.transcriptReader.readAllEvents(record.id, record.threadId, record.catId);
            if (allEvents.length > 0) {
              const handoffSummaries = formatEventsHandoff(allEvents);
              const chatMessages = formatEventsChat(allEvents);
              const extractive = await this.transcriptReader.readDigest(record.id, record.threadId, record.catId);

              const result = await generateHandoffDigest({
                handoffSummaries,
                extractiveDigest: extractive ?? {},
                recentMessages: chatMessages.slice(-8),
                apiKey: profile.apiKey,
                baseUrl: profile.baseUrl,
                ...(this.handoffConfig.fetchFn ? { fetchFn: this.handoffConfig.fetchFn } : {}),
              });

              if (result) {
                const sessionDir = this.transcriptReader.getSessionDir(record.threadId, record.catId, record.id);
                const { TranscriptWriter: TW } = await import('./TranscriptWriter.js');
                await TW.writeHandoffDigest(
                  sessionDir,
                  {
                    v: result.v,
                    model: result.model,
                    generatedAt: result.generatedAt,
                  },
                  result.body,
                );
              }
            }
          }
        }
      } catch {
        clean = false;
        // best-effort: handoff digest failure doesn't prevent sealing
      }
    }

    return clean;
  }

  /**
   * VG-3: Best-effort extraction of decision signals from transcript events + ThreadSummary.
   * Returns undefined if extraction fails or no data available.
   */
  private async extractSignals(record: {
    id: string;
    threadId: string;
    catId: string;
  }): Promise<ReturnType<typeof extractDecisionSignals> | undefined> {
    try {
      // Build transcript text from events
      const events = await this.transcriptReader!.readAllEvents(record.id, record.threadId, record.catId);
      const chatMessages = formatEventsChat(events);
      const transcriptText = chatMessages.map((m) => m.content).join('\n');

      // Get latest ThreadSummary conclusions (if summaryStore available)
      let summaryConclusions: string[] = [];
      let summaryOpenQuestions: string[] = [];
      if (this.summaryStore) {
        const summaries = await this.summaryStore.listByThread(record.threadId);
        if (summaries.length > 0) {
          const latest = summaries[summaries.length - 1];
          summaryConclusions = [...latest.conclusions];
          summaryOpenQuestions = [...latest.openQuestions];
        }
      }

      if (!transcriptText && summaryConclusions.length === 0 && summaryOpenQuestions.length === 0) return undefined;

      return extractDecisionSignals({ transcriptText, summaryConclusions, summaryOpenQuestions });
    } catch {
      // Fail-open: decision extraction failure doesn't affect sealing
      return undefined;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`finalize timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
