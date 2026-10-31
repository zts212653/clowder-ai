/**
 * F075 — Leaderboard service
 * Orchestrates mention stats + work stats into a single response.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LeaderboardRange, LeaderboardStatsResponse } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { AchievementStore } from './achievement-store.js';
import type { GameStore } from './game-store.js';
import { computeMentionStats, type MessageLike } from './mention-stats.js';
import { computeSillyStats } from './silly-stats.js';
import { computeWorkStats, type GitLogEntry, parseGitLog } from './work-stats.js';

const execFileAsync = promisify(execFile);

/** Build catId → displayName map from registry */
function getCatNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const config of Object.values(catRegistry.getAllConfigs())) {
    names[config.id] = config.displayName ?? config.nickname ?? config.id;
  }
  return names;
}

/** Build email → catId map for git attribution */
function getAuthorMap(): Record<string, string> {
  return {
    'noreply@anthropic.com': 'opus',
    'codex@openai.com': 'codex',
    'gemini@google.com': 'gemini',
    'owner@localhost': 'owner',
    'owner@example.com': 'owner',
  };
}

/** Get git log for the repo, optionally filtered by date */
async function fetchGitLog(since?: string): Promise<GitLogEntry[]> {
  const args = ['log', '--format=%H|%ae|%aI|%s|%(trailers:key=Co-authored-by,valueonly,separator=;)'];
  if (since) args.push(`--since=${since}`);

  try {
    const { stdout } = await execFileAsync('git', args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseGitLog(stdout);
  } catch {
    return [];
  }
}

function daysAgoMs(n: number): number {
  return Date.now() - n * 86_400_000;
}

export interface MessageFetcher {
  getRecent(limit?: number): Promise<MessageLike[]> | MessageLike[];
}

export interface LeaderboardStores {
  gameStore?: GameStore;
  achievementStore?: AchievementStore;
  userId?: string;
}

export async function getLeaderboardStats(
  messageFetcher: MessageFetcher,
  range: LeaderboardRange,
  stores?: LeaderboardStores,
): Promise<LeaderboardStatsResponse> {
  const catNames = getCatNames();
  const sinceMs = range === '7d' ? daysAgoMs(7) : range === '30d' ? daysAgoMs(30) : undefined;
  const sinceIso = sinceMs ? new Date(sinceMs).toISOString() : undefined;

  const [allMessages, gitEntries] = await Promise.all([messageFetcher.getRecent(10000), fetchGitLog(sinceIso)]);

  // Filter messages by date range (numeric comparison)
  const messages = sinceMs
    ? (allMessages as MessageLike[]).filter((m) => m.timestamp >= sinceMs)
    : (allMessages as MessageLike[]);

  const mentions = computeMentionStats(messages, catNames, range);
  const work = computeWorkStats(gitEntries, getAuthorMap(), catNames);

  // Phase B: silly stats + game stats
  const silly = computeSillyStats(messages, catNames);
  const games = stores?.gameStore?.computeGameStats(catNames);

  // Phase C: achievements + operator level
  const userId = stores?.userId;
  const achievements = userId ? stores?.achievementStore?.getUnlocked(userId) : undefined;
  const cvoLevel = userId ? stores?.achievementStore?.getCvoLevel(userId) : undefined;

  return {
    mentions,
    work,
    range,
    fetchedAt: new Date().toISOString(),
    ...(silly.entries.length > 0 ? { silly } : {}),
    ...(games ? { games } : {}),
    ...(achievements && achievements.length > 0 ? { achievements } : {}),
    ...(cvoLevel ? { cvoLevel } : {}),
  };
}
