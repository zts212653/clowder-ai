import type { FastifyPluginAsync } from 'fastify';
import type { PortDiscoveryService } from '../domains/preview/port-discovery.js';
import type { AgentPaneRegistry } from '../domains/terminal/agent-pane-registry.js';
import { TerminalSessionStore } from '../domains/terminal/session-store.js';
import type { TmuxGateway } from '../domains/terminal/tmux-gateway.js';
import { getWorktreeRoot } from '../domains/workspace/workspace-security.js';
import { resolveUserId } from '../utils/request-identity.js';

// node-pty is optional — terminal features degrade gracefully when missing
// (e.g. Windows exe packaging where native compilation is impractical)
let pty: typeof import('node-pty') | null = null;
try {
  pty = await import('node-pty');
} catch {
  // node-pty not available — terminal routes will return 503
}

interface TerminalRouteOpts {
  tmuxGateway?: TmuxGateway;
  agentPaneRegistry?: AgentPaneRegistry;
  portDiscovery?: PortDiscoveryService;
}
interface PtyBinding {
  pty: {
    onData: (cb: (data: string) => void) => { dispose: () => void };
    onExit: (cb: () => void) => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
  };
}

export const terminalRoutes: FastifyPluginAsync<TerminalRouteOpts> = async (app, opts) => {
  const { tmuxGateway, agentPaneRegistry, portDiscovery } = opts;
  const store = new TerminalSessionStore();
  const ptys = new Map<string, PtyBinding>();

  if (!pty) {
    app.get('/api/terminal/status', async () => ({ available: false, reason: 'node-pty not installed' }));
    return;
  }
  const ptyMod = pty;

  // --- Auth gate ---
  app.addHook('preHandler', async (req, reply) => {
    if (!resolveUserId(req)) {
      reply.status(401);
      return reply.send({ error: 'Identity required (X-Cat-Cafe-User header or userId query)' });
    }
  });

  // GET /api/terminal/status — availability check for frontend
  app.get('/api/terminal/status', async () => {
    return { available: !!tmuxGateway };
  });

  // POST /api/terminal/sessions — create or reconnect
  app.post<{
    Body: { worktreeId: string; cols?: number; rows?: number };
  }>('/api/terminal/sessions', async (req, reply) => {
    if (!tmuxGateway)
      return reply.status(503).send({ error: 'Terminal not available (CAT_CAFE_TMUX_AGENT not enabled)' });
    const { worktreeId, cols = 80, rows = 24 } = req.body;
    const userId = resolveUserId(req) as string; // preHandler guarantees non-null

    if (!worktreeId) return reply.status(400).send({ error: 'worktreeId is required' });

    let cwd: string;
    try {
      cwd = await getWorktreeRoot(worktreeId);
    } catch {
      return reply.status(404).send({ error: `Worktree not found: ${worktreeId}` });
    }

    const ptyEnv = { ...process.env } as Record<string, string>;
    const ptyOpts = { name: 'xterm-256color' as const, cols, rows, cwd, env: ptyEnv };

    // Reconnect to existing disconnected session if available
    const existing = store.findReconnectable(worktreeId, userId);
    if (existing) {
      const panes = await tmuxGateway.listPanes(worktreeId);
      if (!panes.some((p) => p.paneId === existing.paneId)) {
        store.remove(existing.id); // Stale — fall through to create new
      } else {
        const sock = tmuxGateway.socketName(worktreeId);
        const ptyProcess = ptyMod.spawn(tmuxGateway.tmuxBin, ['-L', sock, 'attach', '-t', existing.paneId], ptyOpts);
        ptys.set(existing.id, { pty: ptyProcess });
        store.markConnected(existing.id);
        return { sessionId: existing.id, paneId: existing.paneId, reconnected: true };
      }
    }

    // Create new tmux pane + PTY
    await tmuxGateway.ensureServer(worktreeId);
    const paneId = await tmuxGateway.createPane(worktreeId, { cols, rows, cwd });
    const sock = tmuxGateway.socketName(worktreeId);
    const ptyProcess = ptyMod.spawn(tmuxGateway.tmuxBin, ['-L', sock, 'attach', '-t', paneId], ptyOpts);

    const session = store.create({ worktreeId, paneId, userId });
    ptys.set(session.id, { pty: ptyProcess });

    return { sessionId: session.id, paneId, reconnected: false };
  });

  // GET /api/terminal/sessions/:sessionId/ws — WebSocket attach
  app.get<{
    Params: { sessionId: string };
  }>('/api/terminal/sessions/:sessionId/ws', { websocket: true }, (socket, req) => {
    const { sessionId } = req.params;
    const userId = resolveUserId(req) as string;
    const session = store.getByIdAndUser(sessionId, userId);
    const binding = ptys.get(sessionId);

    if (!session) {
      socket.close(4004, 'Session not found or not yours');
      return;
    }
    if (!binding) {
      socket.close(4004, 'Session not attached');
      return;
    }

    const { pty: ptyProcess } = binding;

    // PTY output → WebSocket
    const dataHandler = ptyProcess.onData((data) => {
      if (socket.readyState === 1) {
        socket.send(data);
      }
      // F120: Feed terminal output to port discovery (non-blocking)
      if (portDiscovery && session?.worktreeId) {
        for (const line of data.split('\n')) {
          if (line.trim()) portDiscovery.feedStdout(session.worktreeId, sessionId, line).catch(() => {});
        }
      }
    });

    // WebSocket input → PTY
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const msg = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
      try {
        const parsed = JSON.parse(msg) as {
          type: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          ptyProcess.resize(parsed.cols, parsed.rows);
        } else if (parsed.type === 'input' && typeof parsed.data === 'string') {
          ptyProcess.write(parsed.data);
        }
      } catch {
        // Not JSON — treat as raw input
        ptyProcess.write(msg);
      }
    });

    // WS disconnect → mark disconnected but keep pane alive
    socket.on('close', () => {
      dataHandler.dispose();
      ptyProcess.kill(); // Kill PTY bridge, not tmux pane
      ptys.delete(sessionId);
      store.markDisconnected(sessionId);
    });

    // PTY exit (tmux pane died) → mark disconnected
    ptyProcess.onExit(() => {
      socket.close(1000, 'PTY exited');
      ptys.delete(sessionId);
      store.markDisconnected(sessionId);
    });
  });

  // DELETE /api/terminal/sessions/:sessionId
  app.delete<{
    Params: { sessionId: string };
  }>('/api/terminal/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    const userId = resolveUserId(req) as string;
    const session = store.get(sessionId);

    if (!tmuxGateway) return reply.code(503).send({ error: 'Terminal not available' });
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.userId !== userId) return reply.code(403).send({ error: 'Not your session' });

    // Kill PTY if still running, then kill tmux pane
    const binding = ptys.get(sessionId);
    if (binding) {
      binding.pty.kill();
      ptys.delete(sessionId);
    }

    // Kill the tmux pane
    await tmuxGateway.killPane(session.worktreeId, session.paneId);
    store.remove(sessionId);

    // If no more sessions for this worktree, destroy the tmux server
    if (!store.hasRemainingForWorktree(session.worktreeId)) {
      await tmuxGateway.destroyServer(session.worktreeId);
    }

    return { ok: true };
  });

  // GET /api/terminal/sessions — filtered by userId
  app.get<{
    Querystring: { worktreeId?: string };
  }>('/api/terminal/sessions', async (req) => {
    const userId = resolveUserId(req) as string;
    const { worktreeId } = req.query;
    const sessions = worktreeId
      ? store.listByUser(userId).filter((s) => s.worktreeId === worktreeId)
      : store.listByUser(userId);

    return sessions.map((s) => ({
      id: s.id,
      worktreeId: s.worktreeId,
      paneId: s.paneId,
      status: s.status,
    }));
  });

  // GET /api/terminal/agent-panes — list agent panes by worktree + user
  app.get<{
    Querystring: { worktreeId: string };
  }>('/api/terminal/agent-panes', async (req, reply) => {
    if (!agentPaneRegistry) return reply.status(501).send({ error: 'Agent pane tracking not enabled' });
    const userId = resolveUserId(req) as string;
    const { worktreeId } = req.query;
    if (!worktreeId) return reply.status(400).send({ error: 'worktreeId is required' });
    return agentPaneRegistry.listByWorktreeAndUser(worktreeId, userId).map((p) => ({
      invocationId: p.invocationId,
      paneId: p.paneId,
      status: p.status,
      startedAt: p.startedAt,
    }));
  });

  // GET /api/terminal/agent-panes/:paneId/ws — read-only attach to agent pane
  app.get<{
    Params: { paneId: string };
    Querystring: { worktreeId: string };
  }>('/api/terminal/agent-panes/:paneId/ws', { websocket: true }, (socket, req) => {
    const { paneId } = req.params;
    const { worktreeId } = req.query;
    const userId = resolveUserId(req) as string;

    if (!worktreeId || !agentPaneRegistry || !tmuxGateway) {
      socket.close(4004, 'Agent pane tracking not enabled or missing worktreeId');
      return;
    }

    const panes = agentPaneRegistry.listByWorktreeAndUser(worktreeId, userId);
    const paneInfo = panes.find((p) => p.paneId === paneId);
    if (!paneInfo) {
      socket.close(4004, 'Agent pane not found or not yours');
      return;
    }

    const sock = tmuxGateway.socketName(worktreeId);
    const ptyProcess = ptyMod.spawn(tmuxGateway.tmuxBin, ['-L', sock, 'attach', '-r', '-t', paneId], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });

    const dataHandler = ptyProcess.onData((data) => {
      if (socket.readyState === 1) socket.send(data);
      // F120: Feed agent pane output to port discovery (non-blocking)
      if (portDiscovery && worktreeId) {
        for (const line of data.split('\n')) {
          if (line.trim()) portDiscovery.feedStdout(worktreeId, paneId, line).catch(() => {});
        }
      }
    });

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const msg = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
      try {
        const parsed = JSON.parse(msg) as { type: string; cols?: number; rows?: number };
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          ptyProcess.resize(parsed.cols, parsed.rows);
        }
      } catch {
        /* ignore non-JSON */
      }
    });

    socket.on('close', () => {
      dataHandler.dispose();
      ptyProcess.kill();
    });

    ptyProcess.onExit(() => {
      socket.close(1000, 'Agent pane exited');
    });
  });
};
