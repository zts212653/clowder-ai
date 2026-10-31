/**
 * F233 Phase B — Redis key patterns for ball-custody event engine。
 * Bare keys（无 prefix；ioredis keyPrefix 由 RedisClient factory 应用）。照 community-keys。
 *
 * Canonical guarantee: TTL 永不设在任何 ballcustody key（铁律#5 / LL-048）。
 *
 * Naming convention:
 *   ballcustody:events:log:{subjectKey}   → LIST   (per-subject 有序事件)
 *   ballcustody:events:seen               → SET    (全局 sourceEventId 去重)
 *   ballcustody:events:subjects           → SET    (所有有事件的 subjectKey)
 *   ballcustody:projection:{subjectKey}   → STRING (JSON-serialized BallCustodyProjection)
 *   ballcustody:projections:index         → SET    (所有有 projection 的 subjectKey)
 *
 * NOTE on ioredis keyPrefix（照 CommunityEventLog）：
 *   普通命令自动加 prefix；Lua KEYS[] 内的 key 也由 ioredis 加 prefix。
 *   Lua 内 ARGV 派生的动态 key 须显式带 prefix（本 cell 不用 ARGV 派生 key）。
 */
export const BallCustodyKeys = {
  /** Per-subject 事件 LIST：ballcustody:events:log:{subjectKey} */
  eventLog: (subjectKey: string) => `ballcustody:events:log:${subjectKey}`,

  /** 全局 sourceEventId 去重 SET */
  eventsSeen: 'ballcustody:events:seen',

  /** 所有有事件的 subjectKey SET */
  eventsSubjects: 'ballcustody:events:subjects',

  /** Serialized BallCustodyProjection：ballcustody:projection:{subjectKey} */
  projection: (subjectKey: string) => `ballcustody:projection:${subjectKey}`,

  /** 所有有 projection 的 subjectKey index SET */
  projectionsIndex: 'ballcustody:projections:index',
} as const;
