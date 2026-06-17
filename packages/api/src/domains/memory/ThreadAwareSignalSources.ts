import type Database from 'better-sqlite3';
import type { OutputVerifiedSignalSources } from './output-verified-detector.js';
import { SqliteSignalSources } from './SqliteSignalSources.js';

/**
 * F200 AC-D2.1/D2.2/D2.3 — Thread-aware signal sources for OutputVerifiedDetector.
 *
 * Extends SqliteSignalSources (invocation status from evidence.sqlite) with
 * Redis-backed signals from thread messages and PR tracking tasks:
 *
 * - AC-D2.1: operator accept + reviewer approval detected via thread message scanning
 * - AC-D2.2: CI passed detected via pr_tracking task automationState
 * - AC-D2.3: PR merged detected via pr_tracking task status='done'
 *
 * Design: optional interface methods (`isCvoAcceptedForThread?` etc.) keep
 * backward compatibility — old callers using plain SqliteSignalSources still work.
 */

/** Minimal message shape needed for signal detection (subset of StoredMessage). */
export interface SignalMessage {
  id: string;
  userId?: string | null;
  catId?: string | null;
  /** Plain text content string (StoredMessage.content is a string, not parsed blocks). */
  content: string;
  /** F097: Connector source. Present = connector/system message (not human-posted). */
  source?: { connector: string } | null;
}

/** Minimal message store interface (subset of IMessageStore). */
export interface SignalMessageStore {
  getByThread(threadId: string, limit?: number, userId?: string): Promise<SignalMessage[]> | SignalMessage[];
}

/** Minimal task item for signal detection (subset of TaskItem). */
export interface SignalTaskItem {
  kind: string;
  status: string;
  threadId: string;
  automationState?: {
    ci?: {
      lastBucket?: string;
      headSha?: string;
      lastFingerprint?: string;
      /** Terminal PR state — 'merged' | 'closed'. Persisted by CiCdRouter on lifecycle close. */
      prState?: string;
    };
  };
}

/** Minimal task store interface (subset of ITaskStore). */
export interface SignalTaskStore {
  listByThread(threadId: string): Promise<SignalTaskItem[]> | SignalTaskItem[];
}

/**
 * Non-approval context guard — first-pass gate before keyword matching.
 * Returns true when the message is NOT a clear imperative approval:
 * (a) question mark anywhere — "LGTM? not sure", "approved? let me check"
 * (b) ends with question/hedging particle — "可以合入吧", "放行嘛"
 * (c) conditional prefix — "如果没问题再合入", "要是没问题就合入"
 */
function isNonApprovalContext(text: string): boolean {
  if (/[？?]/.test(text)) return true;
  if (/[吗么吧嘛]\s*$/.test(text)) return true;
  if (/^(如果|要是|假如)/.test(text)) return true;
  return false;
}

// operator acceptance: full-text patterns (anchored or word-bounded — safe in long sentences).
const CVO_ACCEPT_PATTERNS = [
  /^\s*(please\s+)?merge(\s+(it|this|the\s+pr|please))?\s*[!.]*$/i,
  /^好[的了]?\s*[，,。.！!]?\s*$/,
  /^可以[了]?\s*$/,
];

// operator acceptance: clause-anchored Chinese patterns.
// Split by clause separators and match only standalone short clauses.
// "看了，没问题" → clause "没问题" matches; "没问题的话再合入" → no clause match.
const CVO_ACCEPT_CLAUSE = [
  /^没问题[的了]?\s*$/,
  /^可以合入[了]?\s*$/,
  /^走起[!！]?\s*$/,
  /^通过[了]?\s*$/,
  /^lgtm[.!]*\s*$/i,
  /^approved?[.!]*\s*$/i,
];

// Negation compound phrases — checked BEFORE positive patterns.
const CVO_NEGATION_PATTERNS = [
  /不通过/,
  /不可以/,
  /别合入/,
  /没通过/,
  /未通过/,
  /\bdo\s+not\s+merge\b/i,
  /\bnot\s+merge\b/i,
  /\bdon'?t\s+merge\b/i,
  /\bnot[\s-]+approved?\b/i,
  /\bnot[\s-]+lgtm\b/i,
];

// Reviewer approval: clause-anchored patterns (Chinese + English).
const REVIEWER_APPROVE_CLAUSE = [
  /^没问题[的了]?\s*$/,
  /^可以合入[了]?\s*$/,
  /^放行[了]?\s*$/,
  /^通过[了]?\s*$/,
  /^lgtm[.!]*\s*$/i,
  /^approved?[.!]*\s*$/i,
];

const REVIEWER_NEGATION_PATTERNS = [
  /不通过/,
  /不放行/,
  /不可以/,
  /没通过/,
  /未通过/,
  /\bnot[\s-]+approved?\b/i,
  /\bnot[\s-]+lgtm\b/i,
];

// Reviewer: tagged round-label patterns (whole-message anchored, no clause split needed).
const REVIEWER_TAGGED_PATTERNS = [/^round\s+\d+\s*:\s*(approved?|lgtm)[.!]*\s*$/i];

/** Split text into clauses and check if any standalone clause matches a pattern. */
function matchesClause(text: string, patterns: RegExp[]): boolean {
  return text.split(/[，,。！!；;、\n]+/).some((seg) => {
    const cl = seg.trim();
    return cl.length > 0 && patterns.some((p) => p.test(cl));
  });
}

/** Max messages to scan (recent first). Approval signals should be near the end. */
const MESSAGE_SCAN_LIMIT = 50;

export class ThreadAwareSignalSources implements OutputVerifiedSignalSources {
  private readonly sqliteSources: SqliteSignalSources;

  constructor(
    db: Database.Database,
    private readonly messageStore: SignalMessageStore,
    private readonly taskStore: SignalTaskStore,
  ) {
    this.sqliteSources = new SqliteSignalSources(db);
  }

  /** Delegate to SqliteSignalSources for recall_events-based invocation status. */
  async getInvocationStatus(invocationId: string): Promise<string | null> {
    return this.sqliteSources.getInvocationStatus(invocationId);
  }

  /**
   * AC-D2.3: Detect PR merge by checking if any pr_tracking task for this thread
   * has status='done' AND automationState.ci.prState='merged'.
   * CiCdRouter marks done on BOTH merged and closed — we must distinguish.
   */
  async isPrMergedForThread(threadId: string): Promise<boolean> {
    const tasks = await this.taskStore.listByThread(threadId);
    const prTasks = tasks.filter((t) => t.kind === 'pr_tracking');
    if (prTasks.length === 0) return false;
    // If any pr_tracking task is still active, thread has pending PR work.
    // Old merged PRs must not leak into new trajectories.
    if (prTasks.some((t) => t.status !== 'done')) return false;
    // All terminal — only the LAST (most recently created) task determines
    // the thread's merge status. An old merged PR followed by a newer closed
    // PR means the thread's latest work ended in closure, not merge.
    const lastTask = prTasks[prTasks.length - 1];
    return lastTask.automationState?.ci?.prState === 'merged';
  }

  /**
   * AC-D2.1: Detect operator (co-creator) acceptance by scanning thread messages.
   * Only human user messages count — cat messages are ignored.
   * Latest decision wins: iterate newest→oldest, first match determines result.
   */
  async isCvoAcceptedForThread(threadId: string): Promise<boolean> {
    const messages = await this.messageStore.getByThread(threadId, MESSAGE_SCAN_LIMIT);
    // Iterate newest→oldest so the latest operator decision takes precedence.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      // Human (operator) message: catId is null/undefined/empty. Cat messages have catId set.
      if (msg.catId) continue;
      // Skip connector/system messages (e.g. CI notifications with "CI 通过").
      if (msg.source) continue;
      const text = extractText(msg);
      if (!text) continue;
      // Negation = explicit rejection → return false (latest decision is rejection).
      if (CVO_NEGATION_PATTERNS.some((p) => p.test(text))) return false;
      // Non-approval context: questions, hedges, conditionals → skip (abstain).
      if (isNonApprovalContext(text)) continue;
      // Full-text patterns: word-bounded English + anchored whole-message Chinese.
      if (CVO_ACCEPT_PATTERNS.some((p) => p.test(text))) return true;
      // Clause-anchored: Chinese keywords only in standalone short clauses.
      if (matchesClause(text, CVO_ACCEPT_CLAUSE)) return true;
    }
    return false;
  }

  /**
   * AC-D2.1: Detect reviewer approval by scanning thread messages.
   * Only cat messages count — human messages are ignored.
   * Latest decision wins: iterate newest→oldest, first match determines result.
   */
  async isReviewerApprovedForThread(threadId: string): Promise<boolean> {
    const messages = await this.messageStore.getByThread(threadId, MESSAGE_SCAN_LIMIT);
    // Iterate newest→oldest so the latest reviewer decision takes precedence.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      // Cat (reviewer) message: catId is set. Human messages have catId null.
      if (!msg.catId) continue;
      // Skip connector/system messages — CiCdRouter sends with catId but also source.
      if (msg.source) continue;
      const text = extractText(msg);
      if (!text) continue;
      // Negation = explicit rejection → return false (latest decision is rejection).
      if (REVIEWER_NEGATION_PATTERNS.some((p) => p.test(text))) return false;
      // Non-approval context: questions, hedges, conditionals → skip (abstain).
      if (isNonApprovalContext(text)) continue;
      // Tagged round-label: "Round 3: APPROVED" (whole-message anchored).
      if (REVIEWER_TAGGED_PATTERNS.some((p) => p.test(text))) return true;
      // Clause-anchored: standalone short clauses (Chinese + English).
      if (matchesClause(text, REVIEWER_APPROVE_CLAUSE)) return true;
    }
    return false;
  }

  /**
   * AC-D2.2: Detect CI passed by checking pr_tracking task automationState.
   * Requires both a pass/success bucket AND fingerprint alignment with current
   * headSha to reject stale passes from old commits.
   */
  async isCiPassedForThread(threadId: string): Promise<boolean> {
    const tasks = await this.taskStore.listByThread(threadId);
    // Only check ACTIVE pr_tracking tasks — done tasks reflect old PR work.
    const activePrTasks = tasks.filter((t) => t.kind === 'pr_tracking' && t.status !== 'done');
    return activePrTasks.some((t) => {
      const ci = t.automationState?.ci;
      if (!ci) return false;
      const isBucketPass = ci.lastBucket === 'pass' || ci.lastBucket === 'success';
      if (!isBucketPass) return false;
      // Require fingerprint alignment: lastFingerprint = `${headSha}:${bucket}`.
      // If headSha changed (new commit), fingerprint won't match → stale pass rejected.
      if (!ci.headSha || !ci.lastFingerprint) return false;
      return ci.lastFingerprint.startsWith(`${ci.headSha}:`);
    });
  }
}

/** Extract plain text from a message's content string. */
function extractText(msg: SignalMessage): string {
  return (msg.content ?? '').trim();
}
