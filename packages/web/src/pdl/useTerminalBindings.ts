'use client';
import { useEffect, useRef, useState } from 'react';
import { API_URL, apiFetch } from '@/utils/api-client';
import { request, write } from './owner-api';

interface TerminalOutput {
  id: string;
  output: string;
  status: 'connecting' | 'connected' | 'disconnected';
  cols: number;
  rows: number;
}
interface AgentPane {
  invocationId: string;
  paneId: string;
  status: 'running' | 'done' | 'crashed';
  startedAt: number;
  /** Owning cat recorded server-side at spawn; null for panes registered before the field existed. */
  catId?: string | null;
}
interface TerminalRead {
  worktreeId: string;
  load: string;
  available: boolean;
  mine: TerminalOutput;
  panes: AgentPane[];
  outputs: Record<string, TerminalOutput>;
}
const empty = (worktreeId: string): TerminalRead => ({
  worktreeId,
  load: 'loading',
  available: false,
  mine: { id: '', output: '', status: 'disconnected', cols: 80, rows: 24 },
  panes: [],
  outputs: {},
});
export function useTerminalBindings(
  worktreeId: string | null,
  ui: { pane: string },
  visible: boolean | number = false,
) {
  const current = useRef(empty(worktreeId ?? ''));
  const [data, pushData] = useState(current.current);
  const held = useRef(data);
  const epoch = useRef(0),
    sockets = useRef(new Map<string, WebSocket>()),
    connecting = useRef<Promise<void>>();
  const selectedSocket = useRef<WebSocket>();
  const changed = () => {
    held.current = {
      ...current.current,
      mine: { ...current.current.mine },
      outputs: Object.fromEntries(Object.entries(current.current.outputs).map(([id, output]) => [id, { ...output }])),
    };
    pushData(held.current);
  };
  const attach = (path: string, output: TerminalOutput, stamp: number) => {
    const url = new URL(path, API_URL || window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.href);
    socket.onopen = () => {
      if (stamp !== epoch.current || sockets.current.get(output.id) !== socket) {
        socket.close();
        return;
      }
      output.status = 'connected';
      if (output === current.current.mine) current.current.load = '';
      socket.send(JSON.stringify({ type: 'resize', cols: output.cols, rows: output.rows }));
      changed();
    };
    socket.onmessage = (event) => {
      if (stamp !== epoch.current || sockets.current.get(output.id) !== socket) return;
      const data: string = event.data;
      output.output += data;
      const record = held.current.mine.id === output.id ? held.current.mine : held.current.outputs[output.id];
      record.output = output.output;
      window.clowderChat.emit('terminal:output', { id: output.id, data });
    };
    socket.onclose = () => {
      if (stamp !== epoch.current || sockets.current.get(output.id) !== socket) return;
      output.status = 'disconnected';
      if (output === current.current.mine) current.current.load = '';
      sockets.current.delete(output.id);
      changed();
    };
    socket.onerror = () => {
      if (stamp === epoch.current && sockets.current.get(output.id) === socket) {
        output.status = 'disconnected';
        changed();
      }
    };
    if (stamp === epoch.current) sockets.current.set(output.id, socket);
    return socket;
  };
  const connect = async (stamp = epoch.current) => {
    if (connecting.current) return connecting.current;
    const s = current.current;
    if (!s.available || s.mine.status !== 'disconnected') return;
    s.mine.status = 'connecting';
    s.load = 'loading';
    changed();
    const pending = write<{ sessionId: string; paneId: string; reconnected: boolean }>('/api/terminal/sessions', {
      worktreeId: s.worktreeId,
      cols: s.mine.cols,
      rows: s.mine.rows,
    }).then((owner) => {
      if (stamp !== epoch.current) {
        // Attaching then closing releases the PTY bridge and preserves the server-owned tmux session.
        attach(
          `/api/terminal/sessions/${encodeURIComponent(owner.sessionId)}/ws`,
          { ...s.mine, id: owner.sessionId },
          stamp,
        );
        return;
      }
      s.mine.id = owner.sessionId;
      s.mine.output = '';
      attach(`/api/terminal/sessions/${encodeURIComponent(owner.sessionId)}/ws`, s.mine, stamp);
      changed();
    });
    connecting.current = pending;
    try {
      await pending;
    } catch (error) {
      if (stamp === epoch.current) {
        s.mine.status = 'disconnected';
        s.load = 'error';
        changed();
      }
      throw error;
    } finally {
      if (connecting.current === pending) connecting.current = undefined;
    }
  };
  const select = () => {
    selectedSocket.current?.close();
    selectedSocket.current = undefined;
    const s = current.current,
      pane = s.panes.find((p) => p.paneId === ui.pane);
    if (!pane) return;
    const output = s.outputs[pane.paneId] ?? { id: pane.paneId, output: '', status: 'connecting', cols: 80, rows: 24 };
    s.outputs[pane.paneId] = output;
    output.output = '';
    output.status = 'connecting';
    selectedSocket.current = attach(
      `/api/terminal/agent-panes/${encodeURIComponent(pane.paneId)}/ws?${new URLSearchParams({ worktreeId: s.worktreeId })}`,
      output,
      epoch.current,
    );
    changed();
  };
  useEffect(() => {
    const stamp = ++epoch.current,
      abort = new AbortController();
    connecting.current = undefined;
    if (!visible || !worktreeId) return; // Periodic: panes and PTY are subscribed only while needed.
    if (current.current.worktreeId !== worktreeId) ui.pane = 'mine';
    current.current =
      current.current.worktreeId === worktreeId ? { ...current.current, load: 'loading' } : empty(worktreeId);
    changed();
    const readPanes = async () => {
      const response = await apiFetch(`/api/terminal/agent-panes?${new URLSearchParams({ worktreeId })}`, {
        signal: abort.signal,
      });
      const panes = response.status === 501 ? [] : await response.json();
      if (!response.ok && response.status !== 501) throw new Error('终端旁观会话读取失败');
      if (stamp === epoch.current) {
        current.current.panes = panes;
        changed();
      }
    };
    void (async () => {
      try {
        const [status] = await Promise.all([
          request<{ available: boolean }>('/api/terminal/status', { signal: abort.signal }),
          readPanes(),
        ]);
        if (stamp !== epoch.current) return;
        current.current.available = status.available;
        current.current.load = status.available ? 'loading' : 'error';
        changed();
        if (status.available) await connect(stamp);
      } catch {
        if (stamp === epoch.current) {
          current.current.load = 'error';
          changed();
        }
      }
    })();
    const poll = () => {
      if (document.hidden) return;
      void readPanes().catch(() => {
        if (stamp === epoch.current) {
          current.current.load = 'error';
          changed();
        }
      });
    };
    const timer = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      epoch.current++;
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
      sockets.current.forEach((socket) => socket.close());
      sockets.current.clear();
      selectedSocket.current = undefined;
    };
  }, [visible, worktreeId]);
  const action = async (name: string, args: Record<string, string>) => {
    const s = current.current;
    if (name === 'terminal:select') {
      select();
      return true;
    }
    if (name === 'terminal:connect' || name === 'tmReconnect') {
      await connect();
      return true;
    }
    if (name === 'terminal:input' || name === 'terminal:resize') {
      const output = args.id === s.mine.id ? s.mine : s.outputs[args.id],
        socket = sockets.current.get(args.id);
      if (!output || !socket || socket.readyState !== WebSocket.OPEN) return true;
      if (name === 'terminal:input') {
        if (args.id !== s.mine.id) return true;
        socket.send(JSON.stringify({ type: 'input', data: args.data }));
      } else {
        const cols = Number(args.cols),
          rows = Number(args.rows);
        if (output.cols === cols && output.rows === rows) return true;
        output.cols = cols;
        output.rows = rows;
        socket.send(JSON.stringify({ type: 'resize', cols: output.cols, rows: output.rows }));
        changed();
      }
      return true;
    }
    if (name === 'terminal:close') {
      const id = s.mine.id;
      if (!id || args.id !== id) throw new Error('终端会话已变化');
      const receipt = await request<{ ok: boolean }>(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!receipt.ok) throw new Error('终端关闭尚未确认');
      sockets.current.get(id)?.close();
      sockets.current.delete(id);
      s.mine.status = 'disconnected';
      s.mine.id = '';
      s.mine.output = '';
      changed();
      return true;
    }
    return false;
  };
  return {
    action,
    get data() {
      return held.current;
    },
  };
}
