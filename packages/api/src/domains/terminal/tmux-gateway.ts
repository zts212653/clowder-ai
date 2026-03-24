import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { CreatePaneOpts, PaneInfo } from './types.js';

const exec = promisify(execFile);

/** Check that a path is a regular file AND is executable */
function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute path to the tmux binary.
 * Priority: CAT_CAFE_TMUX_PATH env → well-known Homebrew/system paths → PATH lookup.
 */
function resolveTmuxBin(): string {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation for non-standard keys
  const envPath = process.env['CAT_CAFE_TMUX_PATH'];
  if (envPath && isExecutable(envPath)) return envPath;

  const candidates = [
    '/opt/homebrew/bin/tmux', // macOS ARM Homebrew
    '/usr/local/bin/tmux', // macOS Intel Homebrew / Linux manual
    '/usr/bin/tmux', // system package
  ];
  for (const p of candidates) {
    if (isExecutable(p)) return p;
  }

  // Last resort: ask the shell (execFileSync inherits PATH from current process)
  try {
    return execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('tmux not found. Install tmux or set CAT_CAFE_TMUX_PATH to its absolute path.');
  }
}

function isNoServerRunningError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = `${error.message}\n${'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''}`;
  return details.includes('no server running') || details.includes('server exited unexpectedly');
}

/**
 * Manages tmux servers: one tmux server per worktree.
 * Uses CLI mode (execFile per command) — simple, reliable, and the terminal endstate.
 */
export class TmuxGateway {
  /** Absolute path to the tmux binary, resolved once at construction */
  readonly tmuxBin: string;
  private activeServers = new Set<string>();

  constructor() {
    this.tmuxBin = resolveTmuxBin();
  }

  /** Socket name for a worktree */
  socketName(worktreeId: string): string {
    return `catcafe-${worktreeId}`;
  }

  private async createDetachedSession(
    sock: string,
    cwd: string,
    shell: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const newSessionArgs = ['-L', sock, 'new-session', '-d', '-x', String(cols), '-y', String(rows), '-c', cwd, shell];

    try {
      await exec(this.tmuxBin, newSessionArgs);
    } catch (error) {
      if (!isNoServerRunningError(error)) throw error;
      try {
        execFileSync(this.tmuxBin, ['-L', sock, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // Stale socket / dead server is already gone — keep going.
      }
      await exec(this.tmuxBin, newSessionArgs);
    }
  }

  /** Ensure a tmux server is running for this worktree */
  async ensureServer(worktreeId: string): Promise<string> {
    const sock = this.socketName(worktreeId);
    if (this.activeServers.has(worktreeId)) return sock;

    // Check if server already running
    try {
      await exec(this.tmuxBin, ['-L', sock, 'list-sessions']);
      this.activeServers.add(worktreeId);
    } catch {
      // Server not running — will be created on first createPane
    }
    return sock;
  }

  /** Create a new pane (creates session if needed) */
  async createPane(worktreeId: string, opts: CreatePaneOpts = {}): Promise<string> {
    const sock = this.socketName(worktreeId);
    const shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh';
    const cwd = opts.cwd ?? process.env.HOME ?? '/tmp';
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;

    if (!this.activeServers.has(worktreeId)) {
      // Create new session (this starts the tmux server)
      await this.createDetachedSession(sock, cwd, shell, cols, rows);
      this.activeServers.add(worktreeId);
    } else {
      try {
        // Add window to existing session
        await exec(this.tmuxBin, ['-L', sock, 'new-window', '-c', cwd, shell]);
      } catch (error) {
        if (!isNoServerRunningError(error)) throw error;
        // The server can die outside this process while the in-memory cache still
        // says it exists (for example between isolated test cases). Self-heal by
        // recreating the detached session instead of leaking the stale cache.
        await this.createDetachedSession(sock, cwd, shell, cols, rows);
      }
    }

    // Get the pane ID of the most recently created pane
    const { stdout } = await exec(this.tmuxBin, ['-L', sock, 'display-message', '-p', '#{pane_id}']);
    return stdout.trim();
  }

  /** List all panes for a worktree */
  async listPanes(worktreeId: string): Promise<PaneInfo[]> {
    const sock = this.socketName(worktreeId);
    try {
      const { stdout } = await exec(this.tmuxBin, [
        '-L',
        sock,
        'list-panes',
        '-a',
        '-F',
        '#{pane_id} #{pane_pid} #{pane_width} #{pane_height}',
      ]);
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(' ');
          return {
            paneId: parts[0] ?? '',
            panePid: Number(parts[1]),
            paneWidth: Number(parts[2]),
            paneHeight: Number(parts[3]),
          };
        });
    } catch {
      return []; // Server not running
    }
  }

  /** Resize a pane */
  async resizePane(worktreeId: string, paneId: string, cols: number, rows: number): Promise<void> {
    const sock = this.socketName(worktreeId);
    await exec(this.tmuxBin, ['-L', sock, 'resize-pane', '-t', paneId, '-x', String(cols), '-y', String(rows)]);
  }

  /** Send keys (text + Enter) to a pane */
  async sendKeys(worktreeId: string, paneId: string, text: string): Promise<void> {
    const sock = this.socketName(worktreeId);
    await exec(this.tmuxBin, ['-L', sock, 'send-keys', '-t', paneId, text, 'Enter']);
  }

  /** Capture pane content as text */
  async capturePane(worktreeId: string, paneId: string): Promise<string> {
    const sock = this.socketName(worktreeId);
    const { stdout } = await exec(this.tmuxBin, ['-L', sock, 'capture-pane', '-t', paneId, '-p']);
    return stdout;
  }

  /** Create an agent pane with remain-on-exit (read-only set AFTER command starts) */
  async createAgentPane(worktreeId: string, opts: CreatePaneOpts = {}): Promise<string> {
    const paneId = await this.createPane(worktreeId, opts);
    const sock = this.socketName(worktreeId);
    // Preserve crash scene: pane stays visible after process exits
    await exec(this.tmuxBin, ['-L', sock, 'set-option', '-t', paneId, 'remain-on-exit', 'on']);
    // NOTE: Do NOT set read-only here — select-pane -d blocks send-keys.
    // Callers should call setPaneReadOnly() AFTER the agent command is running.
    return paneId;
  }

  /** Execute a command in a pane via send-keys (fire-and-forget) */
  async execInPane(worktreeId: string, paneId: string, command: string): Promise<void> {
    const sock = this.socketName(worktreeId);
    // send-keys with literal flag to avoid tmux key interpretation
    await exec(this.tmuxBin, ['-L', sock, 'send-keys', '-t', paneId, command, 'Enter']);
  }

  /** Toggle pane read-only mode */
  async setPaneReadOnly(worktreeId: string, paneId: string, readOnly: boolean): Promise<void> {
    const sock = this.socketName(worktreeId);
    // -d = disable input (read-only), -e = enable input
    await exec(this.tmuxBin, ['-L', sock, 'select-pane', '-t', paneId, readOnly ? '-d' : '-e']);
  }

  /** Kill a specific pane */
  async killPane(worktreeId: string, paneId: string): Promise<void> {
    const sock = this.socketName(worktreeId);
    try {
      await exec(this.tmuxBin, ['-L', sock, 'kill-pane', '-t', paneId]);
    } catch {
      // Pane already dead
    }
  }

  /** Kill the entire tmux server for a worktree */
  async destroyServer(worktreeId: string): Promise<void> {
    const sock = this.socketName(worktreeId);
    try {
      execFileSync(this.tmuxBin, ['-L', sock, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // Already dead
    }
    this.activeServers.delete(worktreeId);
  }
}
