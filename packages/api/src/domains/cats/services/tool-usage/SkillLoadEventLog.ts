/**
 * SkillLoadEventLog — F188 Phase F (AC-F10)
 *
 * Independent log for skill-load events. Supports AS-4 (memory-navigation
 * skill triggered) — carries loadTrigger context that Skill `tool_use`
 * count doesn't (and avoids dedup).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { skillLoadLogKey, TOOL_EVENT_LOG_TTL_SECONDS } from '../stores/redis-keys/tool-event-log-keys.js';
import type { SkillLoadedEvent } from './event-log-types.js';

const log = createModuleLogger('skill-load-event-log');

export class SkillLoadEventLog {
  constructor(private readonly redis: RedisClient) {}

  /** Append a skill-load event. Errors logged, never thrown. */
  async append(event: SkillLoadedEvent): Promise<void> {
    const key = skillLoadLogKey(event.sessionId);
    const member = JSON.stringify(event);
    const score = event.timestamp;

    try {
      const added = await this.redis.zadd(key, score, member);
      if (added > 0) {
        await this.redis.expire(key, TOOL_EVENT_LOG_TTL_SECONDS).catch(noop);
      }
    } catch (err) {
      log.warn({ err, key, skillId: event.skillId }, 'Failed to append skill-load event');
    }
  }

  /** Read all skill-load events for a session, ordered by timestamp ascending. */
  async readBySession(sessionId: string): Promise<SkillLoadedEvent[]> {
    const key = skillLoadLogKey(sessionId);
    const members = await this.redis.zrange(key, 0, -1);
    return members.map((m) => JSON.parse(m) as SkillLoadedEvent);
  }

  /** Count distinct skill loads filtered by skillId. Supports AS-4 metric. */
  async countLoadsBySkill(sessionId: string, skillId: string): Promise<number> {
    const events = await this.readBySession(sessionId);
    return events.filter((e) => e.skillId === skillId).length;
  }
}

function noop(): void {}
