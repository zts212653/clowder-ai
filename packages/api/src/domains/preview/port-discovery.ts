import { validatePort } from './port-validator.js';
import type { DiscoveredPort } from './types.js';

export type FrameworkHint = 'vite' | 'next' | 'webpack' | 'unknown';

const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; framework: FrameworkHint }> = [
  { pattern: /vite/i, framework: 'vite' },
  { pattern: /next\.?js/i, framework: 'next' },
  { pattern: /webpack/i, framework: 'webpack' },
];

const LOCALHOST_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|::1):(\d+)/;

export function detectFramework(text: string): FrameworkHint {
  for (const { pattern, framework } of FRAMEWORK_PATTERNS) {
    if (pattern.test(text)) return framework;
  }
  return 'unknown';
}

export function parsePortFromStdout(line: string): { port: number; framework: FrameworkHint } | null {
  const match = LOCALHOST_URL_RE.exec(line);
  if (!match) return null;

  const port = Number.parseInt(match[1], 10);
  const validation = validatePort(port);
  if (!validation.allowed) return null;

  const framework = detectFramework(line);
  return { port, framework };
}

/**
 * Probe whether a port is reachable via HTTP GET.
 * Returns true if any HTTP response is received (even 404/500).
 */
export async function probePort(port: number, host = 'localhost', timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`http://${host}:${port}/`, { signal: controller.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PortDiscoveryService — monitors tmux pane stdout for dev server port announcements.
 *
 * Terminal captures pane output → calls feedStdout() → if port detected → probes reachability
 * → emits 'discovered' event → frontend receives via Socket.IO → shows toast.
 */
export class PortDiscoveryService {
  private discovered = new Map<string, DiscoveredPort>();
  private inFlight = new Set<string>();
  private listeners: Array<(port: DiscoveredPort) => void> = [];
  private probeFn: (port: number, host?: string) => Promise<boolean>;

  constructor(opts?: { probeFn?: (port: number, host?: string) => Promise<boolean> }) {
    this.probeFn = opts?.probeFn ?? probePort;
  }

  onDiscovered(fn: (port: DiscoveredPort) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  async feedStdout(worktreeId: string, paneId: string, line: string): Promise<void> {
    const parsed = parsePortFromStdout(line);
    if (!parsed) return;

    const key = `${worktreeId}:${parsed.port}`;
    const existing = this.discovered.get(key);
    if (existing?.reachable) return; // Already discovered and reachable — skip
    if (this.inFlight.has(key)) return;

    this.inFlight.add(key);
    let reachable: boolean;
    try {
      reachable = await this.probeFn(parsed.port);
    } finally {
      this.inFlight.delete(key);
    }
    const entry: DiscoveredPort = {
      port: parsed.port,
      source: 'stdout',
      framework: parsed.framework,
      paneId,
      worktreeId,
      reachable,
      discoveredAt: Date.now(),
    };

    this.discovered.set(key, entry);
    if (reachable) {
      for (const fn of this.listeners) fn(entry);
    }
  }

  getDiscoveredPorts(worktreeId?: string): DiscoveredPort[] {
    const all = [...this.discovered.values()];
    return worktreeId ? all.filter((p) => p.worktreeId === worktreeId) : all;
  }

  removePort(worktreeId: string, port: number): void {
    this.discovered.delete(`${worktreeId}:${port}`);
  }

  clear(): void {
    this.discovered.clear();
  }
}
