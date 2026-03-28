/**
 * Tool Usage Counter — F142
 * Fire-and-forget Redis INCR for tool_use events + aggregation reader.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { TOOL_USAGE_TTL_SECONDS, toolUsageKey, toolUsageScanPattern } from '../stores/redis-keys/tool-usage-keys.js';
import { classifyTool, type ToolCategory } from './classify.js';

const log = createModuleLogger('tool-usage');

/** A single counter entry parsed from Redis. */
export interface ToolUsageEntry {
  date: string;
  catId: string;
  category: ToolCategory;
  toolName: string;
  count: number;
}

/** Aggregated report returned by the API. */
export interface ToolUsageReport {
  period: { from: string; to: string };
  summary: {
    totalCalls: number;
    byCategory: Record<ToolCategory, number>;
  };
  topTools: Array<{ name: string; category: ToolCategory; count: number; mcpServer?: string }>;
  daily: Array<{
    date: string;
    native: number;
    mcp: number;
    skill: number;
  }>;
  byCat: Record<string, Record<ToolCategory, number>>;
}

export class ToolUsageCounter {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Record a tool_use event. Fire-and-forget — errors are logged, never thrown.
   */
  recordToolUse(catId: string, toolName: string, toolInput?: Record<string, unknown>): void {
    const classification = classifyTool(toolName, toolInput);
    const date = toDateString(Date.now());
    const key = toolUsageKey(date, catId, classification.category, classification.toolName);

    this.redis
      .incr(key)
      .then((val) => {
        // Set TTL only on first increment (val === 1)
        if (val === 1) {
          this.redis.expire(key, TOOL_USAGE_TTL_SECONDS).catch(noop);
        }
      })
      .catch((err) => {
        log.warn({ err, key }, 'Failed to increment tool usage counter');
      });
  }

  /**
   * Read aggregated tool usage for a date range.
   */
  async aggregate(days: number, filters?: { catId?: string; category?: ToolCategory }): Promise<ToolUsageReport> {
    const entries = await this.scanDays(days);

    const now = new Date();
    const to = toDateString(now.getTime());
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - days + 1);
    const from = toDateString(fromDate.getTime());

    // Apply filters
    const filtered = entries.filter((e) => {
      if (filters?.catId && e.catId !== filters.catId) return false;
      if (filters?.category && e.category !== filters.category) return false;
      return true;
    });

    // Summary
    const byCategory: Record<ToolCategory, number> = { native: 0, mcp: 0, skill: 0 };
    let totalCalls = 0;
    for (const e of filtered) {
      byCategory[e.category] += e.count;
      totalCalls += e.count;
    }

    // Top tools (aggregate by toolName across dates/cats)
    const toolTotals = new Map<string, { category: ToolCategory; count: number }>();
    for (const e of filtered) {
      const existing = toolTotals.get(e.toolName);
      if (existing) {
        existing.count += e.count;
      } else {
        toolTotals.set(e.toolName, { category: e.category, count: e.count });
      }
    }
    const topTools = [...toolTotals.entries()]
      .map(([name, info]) => ({ name, ...info }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Daily breakdown
    const dailyMap = new Map<string, Record<ToolCategory, number>>();
    for (const e of filtered) {
      const day = dailyMap.get(e.date) ?? { native: 0, mcp: 0, skill: 0 };
      day[e.category] += e.count;
      dailyMap.set(e.date, day);
    }
    const daily = [...dailyMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, cats]) => ({ date, ...cats }));

    // By cat
    const byCat: Record<string, Record<ToolCategory, number>> = {};
    for (const e of filtered) {
      if (!byCat[e.catId]) byCat[e.catId] = { native: 0, mcp: 0, skill: 0 };
      byCat[e.catId][e.category] += e.count;
    }

    return { period: { from, to }, summary: { totalCalls, byCategory }, topTools, daily, byCat };
  }

  /** Scan Redis keys for N days of tool-stats data. */
  private async scanDays(days: number): Promise<ToolUsageEntry[]> {
    const entries: ToolUsageEntry[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const date = toDateString(d.getTime());
      const pattern = toolUsageScanPattern(date);

      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;

        if (keys.length > 0) {
          const values = await this.redis.mget(...keys);
          for (let k = 0; k < keys.length; k++) {
            const parsed = parseToolUsageKey(keys[k], values[k]);
            if (parsed) entries.push(parsed);
          }
        }
      } while (cursor !== '0');
    }

    return entries;
  }
}

/** Parse a tool-stats Redis key + value into a ToolUsageEntry. */
function parseToolUsageKey(key: string, value: string | null): ToolUsageEntry | null {
  if (!value) return null;
  // key format: tool-stats:{date}:{catId}:{category}:{toolName}
  const parts = key.split(':');
  // parts[0] = 'tool-stats', parts[1] = date, parts[2] = catId, parts[3] = category, parts[4+] = toolName
  if (parts.length < 5) return null;
  const date = parts[1];
  const catId = parts[2];
  const category = parts[3] as ToolCategory;
  // toolName may contain colons (unlikely but safe)
  const toolName = parts.slice(4).join(':');
  const count = parseInt(value, 10);
  if (!Number.isFinite(count)) return null;
  return { date, catId, category, toolName, count };
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function noop(): void {}
