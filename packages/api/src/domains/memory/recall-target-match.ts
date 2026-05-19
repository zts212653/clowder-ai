// F200: target_match — PG-2 dispatch for consumption detection
import type { TargetRef } from './f200-types.js';
import { parseShellReadPaths } from './parse-shell-read-paths.js';

export function targetMatch(method: string, toolInput: Record<string, unknown>, ref: TargetRef): boolean {
  switch (method) {
    case 'Read': {
      if (ref.kind !== 'doc' && ref.kind !== 'passage') return false;
      const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
      if (ref.kind === 'doc') {
        if (ref.sourcePath !== '' && filePath.includes(ref.sourcePath)) return true;
        if (ref.anchor && filePath.includes(ref.anchor)) return true;
      }
      return false;
    }
    case 'Grep': {
      if (ref.kind !== 'doc') return false;
      const grepPath = typeof toolInput.path === 'string' ? toolInput.path : '';
      if (grepPath === '') return false;
      if (ref.sourcePath !== '' && grepPath.includes(ref.sourcePath)) return true;
      if (ref.anchor && grepPath.includes(ref.anchor)) return true;
      return false;
    }
    case 'graph_resolve': {
      if (ref.kind !== 'doc') return false;
      const query = typeof toolInput.query === 'string' ? toolInput.query : '';
      if (query === '') return false;
      if (ref.sourcePath !== '' && (query === ref.sourcePath || ref.sourcePath.includes(query))) return true;
      if (ref.anchor && (query === ref.anchor || query.includes(ref.anchor))) return true;
      return false;
    }
    case 'read_session_events':
    case 'read_session_digest': {
      if (ref.kind !== 'session' && ref.kind !== 'invocation') return false;
      const sid = typeof toolInput.sessionId === 'string' ? toolInput.sessionId : '';
      const refSid = ref.kind === 'session' ? ref.sessionId : ref.sessionId;
      return sid !== '' && sid === refSid;
    }
    case 'read_invocation_detail': {
      if (ref.kind !== 'invocation') return false;
      const invId = typeof toolInput.invocationId === 'string' ? toolInput.invocationId : '';
      return invId !== '' && invId === ref.invocationId;
    }
    case 'get_thread_context': {
      if (ref.kind !== 'thread') return false;
      const tid = typeof toolInput.threadId === 'string' ? toolInput.threadId : '';
      return tid !== '' && tid === ref.threadId;
    }
    case 'command_execution': {
      // F200 HW-4 根因②a: Codex reads docs via shell-wrapped commands
      // (`/bin/zsh -lc "sed -n '1,260p' FILE"`). Parse safe read-only shell
      // file targets and match against doc sourcePath/anchor (same as Read).
      if (ref.kind !== 'doc') return false;
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (command === '') return false;
      for (const p of parseShellReadPaths(command)) {
        if (ref.sourcePath !== '' && p.includes(ref.sourcePath)) return true;
        if (ref.anchor && p.includes(ref.anchor)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}
