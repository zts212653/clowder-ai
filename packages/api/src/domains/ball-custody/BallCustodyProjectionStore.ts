import { BallProbeRecoveryOwner } from './BallProbeRecoveryOwner.js';
import { RedisBallProbeRecovery } from './ball-probe-recovery-redis.js';
/**
 * BallCustodyProjectionStore — Redis-backed projection store（F233 Phase B）
 * 照 CommunityObjectStore（F168）。TTL 永不设（铁律#5 / LL-048）。
 *   ballcustody:projection:{subjectKey} → STRING (JSON)
 *   ballcustody:projections:index       → SET
 */

import type { BallCustodyProjection } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { BallCustodyKeys } from './ball-custody-keys.js';

export interface IBallCustodyProjectionStore
  extends Pick<
    BallProbeRecoveryOwner,
    | 'initializeRecovery'
    | 'getRecoveryNotice'
    | 'getRecoveryFacts'
    | 'listProbeRecoveryCandidates'
    | 'listIdleRecoveryCandidates'
    | 'finishRecovery'
    | 'claimIdleIntent'
    | 'recordWakeReceipt'
    | 'listWakeAudits'
    | 'finishWakeAudit'
    | 'getWakeAudit'
    | 'recheckWakeAudit'
    | 'listRecoveryNotices'
    | 'finishRecoveryNotice'
    | 'recheckRecovery'
    | 'prepareConfirmedEvent'
    | 'commitConfirmedEvent'
    | 'acknowledgeRebuiltEvent'
  > {
  finishRecoveryRebuild?(subjectKey: string): Promise<void>;
  get(subjectKey: string): Promise<BallCustodyProjection | null>;
  save(projection: BallCustodyProjection): Promise<void>;
  listSubjectKeys(): Promise<string[]>;
  delete(subjectKey: string): Promise<void>;
}

export class RedisBallCustodyProjectionStore extends BallProbeRecoveryOwner implements IBallCustodyProjectionStore {
  constructor(private readonly redis: RedisClient) {
    super(new RedisBallProbeRecovery(redis));
  }

  async get(subjectKey: string): Promise<BallCustodyProjection | null> {
    const raw = await this.redis.get(BallCustodyKeys.projection(subjectKey));
    if (!raw) return null;
    return JSON.parse(raw) as BallCustodyProjection;
  }

  async listSubjectKeys(): Promise<string[]> {
    return this.redis.smembers(BallCustodyKeys.projectionsIndex);
  }
}
