/**
 * F233 Phase A 值班简报阈值常量（Task 0 探查 + plan 钉死，集中归置不散落各处）。
 */

/** blocked task 超龄判睡美人（>7d）→ staleBlocked 区。 */
export const STALE_BLOCKED_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** blocked task 进 needsUser（结构化搁置球）的下限——低于此视为正常等待，不报（AC-A2 防过敏）。 */
export const NEEDS_USER_BLOCKED_MIN_MS = 24 * 60 * 60 * 1000;

/** invocation 死球：draft 新鲜窗（沿用 F194 DEFAULT_FRESH_DRAFT_WINDOW_MS=300s）。 */
export const DEAD_BALL_FRESH_DRAFT_WINDOW_MS = 300_000;

/** invocation 死球：zombie grace（沿用 F194 DEFAULT_ZOMBIE_GRACE_MS=2×draft TTL=600s）。 */
export const DEAD_BALL_ZOMBIE_GRACE_MS = 600_000;

/** 默认态正文最大行数（AC-A4：10 秒可读完）。 */
export const MAX_BRIEFING_BODY_LINES = 15;

/** mention 启发式：只扫近期活跃 thread 的窗口（降噪 + 性能，72h）。 */
export const MENTION_SCAN_ACTIVE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** 条目标题最大字符数（截断后加 …）。 */
export const TITLE_MAX = 60;

/** 值班简报 rich card 的稳定 id：renderBriefingCard 设置 + hasBriefingToday 识别当日已发卡（INV-5）。 */
export const DUTY_BRIEFING_CARD_ID = 'duty-briefing';

/** 值班简报的业务时区：daily cron 与“当日已发”判定必须同源，避免 UTC/PT 漂移。 */
export const BRIEFING_TIMEZONE = 'America/Los_Angeles';
