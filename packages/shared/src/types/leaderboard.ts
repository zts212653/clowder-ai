/**
 * F075 Cat Leaderboard — shared types
 */

/** A cat ranked by a numeric metric */
export interface RankedCat {
  catId: string;
  displayName: string;
  count: number;
  rank: number;
}

/** A cat ranked by streak (consecutive days) */
export interface StreakCat {
  catId: string;
  displayName: string;
  currentStreak: number;
  maxStreak: number;
  rank: number;
}

export type LeaderboardRange = 'all' | '7d' | '30d';

export interface MentionStats {
  favoriteCat: RankedCat[];
  nightOwl: RankedCat[];
  streak: StreakCat[];
  chatty: RankedCat[];
}

export interface WorkStats {
  commits: RankedCat[];
  reviews: RankedCat[];
  bugFixes: RankedCat[];
}

/** Phase B: "笨蛋猫猫" entry */
export interface SillyCatEntry {
  catId: string;
  displayName: string;
  label: string;
  description: string;
  count: number;
}

export interface SillyStats {
  entries: SillyCatEntry[];
}

/** Phase B: Game record */
export interface GameRecord {
  id: string;
  game: string;
  catId: string;
  result: 'win' | 'lose' | 'mvp' | 'shame';
  detail?: string;
  timestamp: number;
}

export type GameRecordInput = Omit<GameRecord, 'id'>;

export interface GameStats {
  catKill: { wins: number; mvps: number; topCat?: RankedCat };
  whoSpy: { shameCount: number; shameCat?: RankedCat };
}

/** Phase C: Achievement badge */
export interface Achievement {
  id: string;
  /** Preferred icon key from the café SVG set (F056). */
  icon?: string;
  /** Legacy fallback for old records/messages. */
  emoji?: string;
  label: string;
  description: string;
  category: 'cvo' | 'daily';
  unlockedAt?: number;
}

/** Phase C: CVO ability level */
export interface CvoLevel {
  level: number;
  title: string;
  description: string;
  progress: number;
  nextTitle?: string;
  needed?: number;
}

/** Phase C: Inbound event from external systems (F087 etc.) */
export interface LeaderboardEvent {
  eventId: string;
  source: 'bootcamp' | 'chat' | 'git' | 'game' | 'system' | 'manual';
  catId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: string;
  userId?: string;
}

export interface LeaderboardStatsResponse {
  mentions: MentionStats;
  work: WorkStats;
  range: LeaderboardRange;
  fetchedAt: string;
  silly?: SillyStats;
  games?: GameStats;
  achievements?: Achievement[];
  cvoLevel?: CvoLevel;
}
