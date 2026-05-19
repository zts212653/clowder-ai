/**
 * F198 Phase B: JobEventConsumer
 *
 * Consumes Anthropic Agent View daemon job artifacts:
 *   - ~/.claude/jobs/<short>/state.json    (terminal state machine)
 *   - ~/.claude/jobs/<short>/timeline.jsonl (event stream)
 *
 * Replaces stdout NDJSON consumption used by ClaudeAgentService (-p mode).
 *
 * 砚砚 review guard #3: per-line try/catch when parsing jsonl —
 * one malformed line must not kill the entire consumer stream.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const JOBS_DIR = join(HOME, '.claude/jobs');

/** State machine values emitted by Anthropic Agent View daemon. */
export type JobState = 'queued' | 'working' | 'done' | 'error' | 'idle';

export interface JobStateSnapshot {
  state: JobState;
  detail?: string;
  tempo?: string;
  inFlight?: { tasks: number; queued: number; kinds: string[] };
  output?: { result?: string };
  sessionId?: string;
  daemonShort?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Path to the linked transcript jsonl (full conversation). */
  linkScanPath?: string;
  /** When non-null, claude --bg opted into a sub-worktree. */
  worktree?: string | null;
  worktreePath?: string | null;
}

export interface JobTimelineEvent {
  at: string;
  state: JobState;
  detail?: string;
  text?: string;
}

export interface JobEventConsumerOptions {
  /** Test seam — override default ~/.claude/jobs base dir. */
  jobsDir?: string;
}

export class JobEventConsumer {
  readonly shortId: string;
  readonly jobDir: string;

  constructor(shortId: string, options?: JobEventConsumerOptions) {
    this.shortId = shortId;
    this.jobDir = join(options?.jobsDir ?? JOBS_DIR, shortId);
  }

  /**
   * Read state.json snapshot; returns null if file does not exist yet OR
   * the read returns malformed/partial JSON.
   *
   * codex review (PR #1666 round 3) P2: daemon writes state.json
   * asynchronously, so polling can hit a partial write and JSON.parse will
   * throw. waitForTerminal must not abort on transient parse failure —
   * treat it as "not ready, keep polling", matching the per-line guard
   * pattern already used in readTimeline / readTranscriptEntrypoints.
   */
  async readState(): Promise<JobStateSnapshot | null> {
    const statePath = join(this.jobDir, 'state.json');
    if (!existsSync(statePath)) return null;
    try {
      const content = await readFile(statePath, 'utf8');
      return JSON.parse(content) as JobStateSnapshot;
    } catch {
      // Transient malformed/partial state.json — let caller poll again.
      return null;
    }
  }

  /**
   * Read timeline.jsonl events.
   *
   * Guard: per-line try/catch — malformed lines are skipped, not fatal.
   */
  async readTimeline(): Promise<JobTimelineEvent[]> {
    const timelinePath = join(this.jobDir, 'timeline.jsonl');
    if (!existsSync(timelinePath)) return [];
    const content = await readFile(timelinePath, 'utf8');
    const events: JobTimelineEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as JobTimelineEvent);
      } catch {
        // Skip malformed line; one bad event must not kill the consumer.
      }
    }
    return events;
  }

  /**
   * Poll state.json until state ∈ {done, error} or timeout.
   *
   * 砚砚 review guard #1: distinguishes terminal states. Caller is
   * responsible for treating state==='error' as failure.
   *
   * codex review (PR #1666 round 3) P1: default timeout MUST be large
   * enough to not falsely fail long-running --bg jobs. LLM jobs with
   * thinking + tool calls + long output routinely exceed 45s. Default
   * raised to 30 minutes; caller (e.g. invoke pipeline with explicit
   * AbortSignal) is responsible for tighter cancellation when needed.
   */
  async waitForTerminal(opts?: {
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
  }): Promise<JobStateSnapshot> {
    const timeoutMs = opts?.timeoutMs ?? 30 * 60_000; // 30 min default; caller overrides as needed
    const pollMs = opts?.pollMs ?? 500;
    const signal = opts?.signal;
    const deadline = Date.now() + timeoutMs;
    let last: JobStateSnapshot | null = null;
    while (Date.now() < deadline) {
      // codex review (PR #1666 round 4) P1: honor AbortSignal at every poll
      // tick so invoke-single-cat cancellation actually stops the loop
      // promptly. Caller is responsible for catching the rejection and
      // issuing `claude stop <short>` to release the background job.
      if (signal?.aborted) {
        throw new Error(`JobEventConsumer.waitForTerminal: aborted (signal.aborted) for ${this.shortId}`);
      }
      last = await this.readState();
      if (last?.state === 'done' || last?.state === 'error') return last;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!last) {
      throw new Error(
        `JobEventConsumer.waitForTerminal: state.json never appeared for ${this.shortId} within ${timeoutMs}ms`,
      );
    }
    throw new Error(`JobEventConsumer.waitForTerminal: timeout ${timeoutMs}ms; last state=${last.state}`);
  }

  /** Count entrypoint values in the linked transcript jsonl (for AC-B6 verification). */
  async readTranscriptEntrypoints(transcriptPath: string): Promise<Record<string, number>> {
    if (!existsSync(transcriptPath)) return {};
    const content = await readFile(transcriptPath, 'utf8');
    const counts: Record<string, number> = {};
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { entrypoint?: string };
        const ep = obj.entrypoint ?? '(none)';
        counts[ep] = (counts[ep] ?? 0) + 1;
      } catch {
        // Per-line guard: skip malformed transcript lines.
      }
    }
    return counts;
  }
}
