/**
 * F210 Phase H1: AgyTrajectoryObserver
 *
 * 旁路读 AGY cascade 的 SQLite trajectory store（`<appDataDir>/conversations/<uuid>.db` 的
 * `steps` 表），按 `idx` 游标增量 poll 出 progress events，做 side-channel 进度可见。
 *
 * 关键边界（owner 砚砚 AC，2026-06-01）：
 * - H1 只做 progress side-channel，**不替换最终 stdout 回复**（根治 resume 重放归 H2）。
 * - fail-open：SQLite 任何不可用（文件缺失 / 表或列缺失 / 锁 / 损坏）→ `enabled=false`，
 *   调用方必须降级回现有 stdout 行为，绝不影响最终答复语义。
 * - 中性文案：H1 不把 `step_type` 硬标成 tool call/思考；枚举坐实后（H3）再加语义标签。
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { extractAntigravityCliConversationId } from './antigravity-cli-event-parser.js';

export interface AgyProgressEvent {
  readonly idx: number;
  readonly stepType: number;
  readonly status: number;
  /** 中性进度文案（不解 step_type 语义）。 */
  readonly label: string;
  readonly payload?: Buffer;
}

export interface AgyPollResult {
  /** fail-open 信号：false = SQLite 不可用，调用方降级回现有 stdout 行为。 */
  readonly enabled: boolean;
  /** `idx > cursor` 的新 step（按 idx 升序）。 */
  readonly events: AgyProgressEvent[];
  /** 新游标（见过的最大 idx）；无新 step 时等于传入 cursor。 */
  readonly cursor: number;
}

const REQUIRED_COLUMNS = ['idx', 'step_type', 'status'] as const;
// F210-H1b (cloud P2): keep this small. better-sqlite3 is synchronous, so a long busy_timeout blocks
// the API event loop while AGY's writer holds the lock. Progress is optional side-channel telemetry —
// fail open fast and rely on the next poll's retry instead of stalling the event loop for seconds.
const BUSY_TIMEOUT_MS = 50;

/**
 * AGY step status 是明文 integer。实测 status=3 出现在已完成 step；H1 保守只区分
 * 完成/进行中，不依赖未坐实的完整 status 枚举。
 */
function statusWord(status: number): string {
  return status === 3 ? 'completed' : 'running';
}

/**
 * F210 H3 (砚砚 scope，证据支撑的粗标签，不全枚举逆向)：
 * - 15 → assistant activity（H2b 证同 step 含 final+thinking，不标纯 thinking）
 * - 14 / 98 → lifecycle（保守，证据不足只给生命周期级）
 * - 23 → metadata（footer/session 元数据，B spike §7.3 实测）
 * - 9 → operation activity（不硬标 tool call，缺 proto 证据）
 * - 其他 → null（未知一律 neutral，不猜）
 */
function stepTypeLabel(stepType: number): string | null {
  switch (stepType) {
    case 15:
      return 'assistant activity';
    case 14:
    case 98:
      return 'lifecycle';
    case 23:
      return 'metadata';
    case 9:
      return 'operation activity';
    default:
      return null;
  }
}

function neutralLabel(idx: number, stepType: number, status: number): string {
  const semantic = stepTypeLabel(stepType);
  const suffix = semantic ? ` (${semantic})` : '';
  return `AGY trajectory step #${idx}${suffix} ${statusWord(status)}`;
}

const APP_DATA_DIR_RE = /appDataDir=(\S+)/;

/**
 * 从 agy print-mode log 解析出 trajectory SQLite DB 路径：
 * `<appDataDir>/conversations/<cascade-uuid>.db`。appDataDir 或 cascade UUID 任一缺失
 * → null（调用方据此不启动 progress 观测，降级回现有 stdout 行为）。
 */
export function resolveAgyTrajectoryDbPath(logText: string): string | null {
  const appDataDir = logText.match(APP_DATA_DIR_RE)?.[1];
  const uuid = extractAntigravityCliConversationId(logText);
  if (!appDataDir || !uuid) return null;
  return join(appDataDir, 'conversations', `${uuid}.db`);
}

export interface AgyDbCandidate {
  readonly path: string;
  /** 文件创建时间（ms epoch）。 */
  readonly birthtimeMs: number;
  /** 文件最后修改时间（ms epoch）。 */
  readonly mtimeMs: number;
}

export interface LocateAgyTrajectoryDbDeps {
  /** agy `--log-file` 当前内容（fresh turn 带 conversation id + appDataDir；resume turn 为空）。 */
  readonly logText: string;
  /**
   * AGY profile 的 appDataDir。fresh turn 可从 log 解析，但 resume turn log 为空，
   * 调用方（GeminiAgentService）必须独立从 spawn agy 的 profile/HOME 传入，否则无法扫描。
   */
  readonly appDataDir: string | null;
  /** 本次 invocation 启动时刻（ms epoch）；用于筛掉历史 cascade db，只认本轮新建/更新的。 */
  readonly invocationStartMs: number;
  /** DI：列出 `<appDataDir>/conversations/*.db` 候选（path + 时间戳）。生产用 fs；测试注入。 */
  readonly listConversationDbs: (appDataDir: string) => AgyDbCandidate[];
}

/**
 * 定位本轮 AGY trajectory 的 SQLite DB（F210 H2a，B spike §8 confirmed）。
 *
 * - **fresh turn**：log 带 conversation id（== cascade id == DB 文件名），走现有
 *   `resolveAgyTrajectoryDbPath`。
 * - **resume turn**：agy resume **不写 `--log-file`** 且**另起新 cascade db**（≠ 原 conversation
 *   db），log 解析失败。改扫 `conversations/*.db`，只接受 `invocationStart` 后新建/更新的候选。
 * - **fail-open**：appDataDir 缺失 / 0 候选 / 多候选无法消歧 → null（调用方降级，绝不猜——
 *   避免历史或并发 invocation 的 db 污染，砚砚 spec）。
 */
export function locateAgyTrajectoryDb(deps: LocateAgyTrajectoryDbDeps): string | null {
  const fresh = resolveAgyTrajectoryDbPath(deps.logText);
  if (fresh) return fresh;
  if (!deps.appDataDir) return null;
  const candidates = deps
    .listConversationDbs(deps.appDataDir)
    .filter((c) => c.birthtimeMs >= deps.invocationStartMs || c.mtimeMs >= deps.invocationStartMs);
  if (candidates.length !== 1) return null;
  return candidates[0]!.path;
}

/**
 * 派生 AGY appDataDir（云端 codex P2）：必须用 **spawn agy 的 effective child HOME**
 * （`childEnv.HOME`，合并了 agyProfile / accountEnv / callbackEnv），不能用进程 `homedir()`。
 * 否则无 agyProfile 但 accountEnv 提供 HOME 时，child 用 accountEnv.HOME 写 trajectory，
 * 而 scan root 错用 homedir() → resume turn 永久扫错目录、零 progress。
 */
export function resolveAgyAppDataDir(childEnv: Record<string, string> | undefined): string {
  return join(childEnv?.HOME ?? homedir(), '.gemini', 'antigravity-cli');
}

/**
 * fs 生产实现：扫 `<appDataDir>/conversations/*.db` 返回候选（path + birthtime/mtime）。
 * 目录不存在 / 不可读 → `[]`（fail-open，调用方降级）。单个文件 stat 失败跳过该文件。
 */
export function listAgyConversationDbs(appDataDir: string): AgyDbCandidate[] {
  const convDir = join(appDataDir, 'conversations');
  let entries: string[];
  try {
    entries = readdirSync(convDir);
  } catch {
    return [];
  }
  const out: AgyDbCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const path = join(convDir, name);
    try {
      const st = statSync(path);
      out.push({ path, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs });
    } catch {
      // 单文件 stat 失败（并发删除等）→ 跳过，不影响其他候选。
    }
  }
  return out;
}

export class AgyTrajectoryObserver {
  private readonly dbPath: string;
  private db: Database.Database | null = null;
  private readonly activeIdxs = new Set<number>();
  private readonly lastSeenStatus = new Map<number, number>();
  /**
   * Permanent fail-open ONLY when the steps table exists but is schema-incompatible.
   * Transient unavailability (DB file/table not created yet, lock) is RETRYABLE — AGY can write
   * the conversation log before the SQLite store is created/flushed (startup race, 砚砚 P1-1).
   */
  private incompatible = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Open read-only connection + capability probe.
   * @returns 'ready' (open + schema ok) | 'retry' (transient: file/table not ready or locked —
   *          try again next poll) | 'incompatible' (table exists but schema mismatch — permanent).
   */
  private ensureOpen(): 'ready' | 'retry' | 'incompatible' {
    if (this.incompatible) return 'incompatible';
    if (this.db) return 'ready';
    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return 'retry'; // file not created yet / cannot open → startup race, retry next poll
    }
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const cols = db.prepare('PRAGMA table_info(steps)').all() as Array<{ name: string }>;
      if (cols.length === 0) {
        db.close();
        return 'retry'; // steps table not created yet → startup race, retry
      }
      const colNames = new Set(cols.map((c) => c.name));
      if (!REQUIRED_COLUMNS.every((c) => colNames.has(c))) {
        db.close();
        this.incompatible = true;
        return 'incompatible'; // table exists but schema mismatch → permanent fail-open
      }
      this.db = db;
      return 'ready';
    } catch {
      db.close();
      return 'retry'; // lock / transient read error → retry
    }
  }

  /** 增量读取 `idx > cursor` 的新 step，以及未完成步骤的状态更新。SQLite 不可用降级（enabled=false），不抛。 */
  poll(cursor: number): AgyPollResult {
    if (this.ensureOpen() !== 'ready' || !this.db) {
      return { enabled: false, events: [], cursor };
    }
    try {
      const placeholders = Array.from(this.activeIdxs)
        .map(() => '?')
        .join(',');
      const sql = `SELECT idx, step_type, status, step_payload FROM steps WHERE idx > ? ${
        this.activeIdxs.size > 0 ? `OR idx IN (${placeholders})` : ''
      } ORDER BY idx`;

      const stmt = this.db.prepare(sql);
      const params = this.activeIdxs.size > 0 ? [cursor, ...this.activeIdxs] : [cursor];

      const rows = stmt.all(params) as Array<{
        idx: number;
        step_type: number;
        status: number;
        step_payload: Buffer | null;
      }>;

      const events: AgyProgressEvent[] = [];

      for (const r of rows) {
        const prevStatus = this.lastSeenStatus.get(r.idx);
        if (prevStatus === undefined || r.status !== prevStatus) {
          events.push({
            idx: r.idx,
            stepType: r.step_type,
            status: r.status,
            label: neutralLabel(r.idx, r.step_type, r.status),
            payload: r.step_payload ?? undefined,
          });
          this.lastSeenStatus.set(r.idx, r.status);
        }

        if (r.status === 3) {
          this.activeIdxs.delete(r.idx);
          this.lastSeenStatus.delete(r.idx);
        } else {
          this.activeIdxs.add(r.idx);
        }
      }

      const nextCursor = events.length > 0 ? Math.max(cursor, ...events.map((e) => e.idx)) : cursor;
      return { enabled: true, events, cursor: nextCursor };
    } catch {
      // 运行中读失败（半行 / 锁超时）→ 关闭重置，下次重试（不永久放弃）。
      this.close();
      return { enabled: false, events: [], cursor };
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* best-effort: 关闭失败不影响调用方。 */
      }
      this.db = null;
    }
  }
}

export interface ObserveAgyProgressDeps {
  /** 读 agy `--log-file` 的当前内容（fresh turn 解析 conversation id + appDataDir）。 */
  readLog: () => string;
  /** agy 进程是否已结束（结束后做一次 final poll 捞尾部 step）。 */
  isAgyDone: () => boolean;
  /** 注入 sleep（生产用真 timer；测试注入即时 resolve 以控制时序）。 */
  sleep: (ms: number) => Promise<void>;
  /** poll 间隔，默认 500ms。 */
  pollIntervalMs?: number;
  /** 取消信号（用户中断时停止观测）。 */
  signal?: AbortSignal;
  /**
   * AGY profile appDataDir：resume turn log 为空时靠扫描定位 cascade db（B spike §8.3）。
   * fresh turn 可不传（locator 从 log 解析）。
   */
  appDataDir?: string | null;
  /** 本次 invocation 启动时刻（ms epoch）：筛掉历史 cascade db，只认本轮新建/更新的。 */
  invocationStartMs?: number;
  /** DI：列 `<appDataDir>/conversations/*.db` 候选（resume 扫描）；默认空 → resume fail-open。 */
  listConversationDbs?: (appDataDir: string) => AgyDbCandidate[];
}

/**
 * agy 跑期间增量观测 trajectory，yield progress events（H1 side-channel，不碰最终 stdout）。
 *
 * 每 pollIntervalMs 解析一次 DB 路径（agy 早期把 cascade UUID 写进 log），解析到就用
 * AgyTrajectoryObserver 按 idx 游标增量 poll 并 yield 新 step；agy 结束后做一次 final poll
 * 捞最后写入的 step。SQLite 不可用时 observer 自身 fail-open（不 yield、不抛），本 generator
 * 因此自然降级为零产出，绝不影响最终答复语义。
 */
export async function* observeAgyProgress(deps: ObserveAgyProgressDeps): AsyncGenerator<AgyProgressEvent> {
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  let observer: AgyTrajectoryObserver | null = null;
  let cursor = -1;

  const ensureObserver = (): AgyTrajectoryObserver | null => {
    if (!observer) {
      // carryover（砚砚 locator review non-blocking note）：扫描历史 db 必须有 invocationStart
      // watermark；缺 watermark 时不扫（appDataDir 置 null → locator 仅走 fresh log path），
      // 避免未来 caller 传 appDataDir 但漏 watermark 时误读历史库。
      const hasWatermark = deps.invocationStartMs !== undefined;
      const dbPath = locateAgyTrajectoryDb({
        logText: deps.readLog(),
        appDataDir: hasWatermark ? (deps.appDataDir ?? null) : null,
        invocationStartMs: deps.invocationStartMs ?? 0,
        listConversationDbs: deps.listConversationDbs ?? (() => []),
      });
      if (dbPath) observer = new AgyTrajectoryObserver(dbPath);
    }
    return observer;
  };

  while (!deps.isAgyDone() && !deps.signal?.aborted) {
    const obs = ensureObserver();
    if (obs) {
      const r = obs.poll(cursor);
      if (r.enabled) {
        cursor = r.cursor;
        yield* r.events;
      }
    }
    await deps.sleep(pollIntervalMs);
  }

  // final poll：agy 结束后捞最后写入但上一轮 poll 没覆盖的 step。
  const finalObs = ensureObserver();
  if (finalObs) {
    const r = finalObs.poll(cursor);
    if (r.enabled) yield* r.events;
    finalObs.close();
  }
}
