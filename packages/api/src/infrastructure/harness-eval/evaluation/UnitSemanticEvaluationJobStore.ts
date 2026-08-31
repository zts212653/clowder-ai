import type { EvaluationSnapshot, MetricResult, TraceEpisode } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const JOB_PREFIX = 'harness-unit-semantic-job:';
const RECEIPT_PREFIX = 'harness-unit-semantic-retrieval:';
const COMPLETION_PREFIX = 'harness-unit-semantic-completion:';

export interface UnitSemanticEvaluationJob {
  jobId: string;
  ownerUserId: string;
  evaluatorCatId: string;
  snapshotId: string;
  objectiveId: string;
  metricId: string;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: EvaluationSnapshot['unitRefs'];
  window: EvaluationSnapshot['window'];
  orderedInvocationIds: string[];
  priorityAnchorIds: string[];
  createdAt: number;
}

export interface UnitSemanticEpisodePacket {
  invocationId: string;
  traceTurnId: string;
  threadId: string;
  catId: string;
  terminalAt: number;
  terminalKind: string;
  toolCalls: TraceEpisode['terminal']['toolCalls'];
  segments: TraceEpisode['summary']['segments'];
  inputText: string | null;
  outputText: string | null;
  contextMessages: Array<{ messageId: string; catId: string | null; content: string }>;
}

export interface UnitSemanticRetrievalReceipt {
  cursor: number;
  nextCursor: number;
  invocationIds: string[];
  /**
   * Digests of the exact bounded evidence returned to the eval cat. Message
   * bodies stay in their canonical store so deletion cannot leave a shadow
   * copy in the evaluation ledger.
   */
  evidenceDigests: string[];
  createdAt: number;
}

export interface UnitSemanticEvaluationCompletion {
  submissionDigest: string;
  result: MetricResult;
  unitCompleted: boolean;
  completedAt: number;
}

const jobKey = (jobId: string) => `${JOB_PREFIX}${jobId}`;
const receiptKey = (jobId: string, cursor: number) => `${RECEIPT_PREFIX}${jobId}:${cursor}`;
const completionKey = (jobId: string) => `${COMPLETION_PREFIX}${jobId}`;

/**
 * Persistent Unit-eval job ledger. Retrieval is an append-only chain keyed by
 * cursor, so duplicate requests replay the same batch and concurrent callers
 * cannot create gaps or rewrite which frozen traces the evaluator received.
 */
export class UnitSemanticEvaluationJobStore {
  constructor(private readonly redis: RedisClient) {}

  async append(job: UnitSemanticEvaluationJob): Promise<{ outcome: 'created' | 'duplicate' }> {
    const serialized = JSON.stringify(job);
    const created = await this.redis.set(jobKey(job.jobId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(jobKey(job.jobId));
      if (existing !== serialized) throw new Error(`unit_semantic_job_conflict:${job.jobId}`);
    }
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(jobId: string): Promise<UnitSemanticEvaluationJob | null> {
    const raw = await this.redis.get(jobKey(jobId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UnitSemanticEvaluationJob;
    } catch {
      return null;
    }
  }

  async appendReceipt(
    jobId: string,
    receipt: UnitSemanticRetrievalReceipt,
  ): Promise<{ outcome: 'created' | 'duplicate'; receipt: UnitSemanticRetrievalReceipt }> {
    const key = receiptKey(jobId, receipt.cursor);
    const serialized = JSON.stringify(receipt);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created === 'OK') return { outcome: 'created', receipt };
    const existingRaw = await this.redis.get(key);
    if (!existingRaw) throw new Error(`unit_semantic_retrieval_conflict:${jobId}:${receipt.cursor}`);
    const existing = JSON.parse(existingRaw) as UnitSemanticRetrievalReceipt;
    return { outcome: 'duplicate', receipt: existing };
  }

  async getReceipt(jobId: string, cursor: number): Promise<UnitSemanticRetrievalReceipt | null> {
    const raw = await this.redis.get(receiptKey(jobId, cursor));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UnitSemanticRetrievalReceipt;
    } catch {
      return null;
    }
  }

  async contiguousReceipts(jobId: string): Promise<UnitSemanticRetrievalReceipt[]> {
    const receipts: UnitSemanticRetrievalReceipt[] = [];
    let cursor = 0;
    while (true) {
      const receipt = await this.getReceipt(jobId, cursor);
      if (!receipt) break;
      if (receipt.cursor !== cursor || receipt.nextCursor !== cursor + receipt.invocationIds.length) {
        throw new Error(`unit_semantic_retrieval_corrupt:${jobId}:${cursor}`);
      }
      if (receipt.evidenceDigests.length !== receipt.invocationIds.length) {
        throw new Error(`unit_semantic_retrieval_corrupt:${jobId}:${cursor}`);
      }
      receipts.push(receipt);
      if (receipt.nextCursor === cursor) break;
      cursor = receipt.nextCursor;
    }
    return receipts;
  }

  async getCompletion(jobId: string): Promise<UnitSemanticEvaluationCompletion | null> {
    const raw = await this.redis.get(completionKey(jobId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UnitSemanticEvaluationCompletion;
    } catch {
      return null;
    }
  }

  async complete(jobId: string, completion: UnitSemanticEvaluationCompletion): Promise<'created' | 'duplicate'> {
    const key = completionKey(jobId);
    const serialized = JSON.stringify(completion);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(key);
      if (existing !== serialized) throw new Error(`unit_semantic_completion_conflict:${jobId}`);
    }
    return created === 'OK' ? 'created' : 'duplicate';
  }
}
