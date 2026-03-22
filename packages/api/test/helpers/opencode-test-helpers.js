/**
 * Shared test helpers for opencode tests.
 * Mock process, event emitter, and OMOC fixture factories.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { ensureFakeCliOnPath } from './fake-cli-path.js';

ensureFakeCliOnPath('opencode');

export function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 54321,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

function emitProcessExit(proc, code, signal = null) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, signal);
  });
}

export function emitOpenCodeEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, 0, null);
  });
  proc.stdout.end();
}

export async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

// ── Cat Cafe identifiers ──

export const CAT_CAFE_HANDLES = ['@opus', '@codex', '@gemini', '@sonnet', '@gpt52', '@opencode'];
export const CAT_CAFE_CAT_IDS = ['opus', 'codex', 'gemini', 'sonnet', 'gpt52'];

// ── OMOC event fixtures ──

export const OMOC_STEP_START = {
  type: 'step_start',
  timestamp: 1773304958492,
  sessionID: 'ses_omoc_test',
  part: { type: 'step-start', id: 'prt_omoc1', sessionID: 'ses_omoc_test', messageID: 'msg_omoc1' },
};

export const OMOC_SISYPHUS_TEXT = {
  type: 'text',
  timestamp: 1773304958500,
  sessionID: 'ses_omoc_test',
  part: {
    type: 'text',
    text: 'I will decompose this task using my expert team. Let me delegate to the Oracle for codebase analysis and the Librarian for documentation lookup.',
  },
};

export const OMOC_DELEGATE_ORACLE = {
  type: 'tool_use',
  timestamp: 1773304960000,
  sessionID: 'ses_omoc_test',
  part: {
    type: 'tool',
    callID: 'toolu_delegate_1',
    tool: 'delegate-task',
    state: {
      status: 'completed',
      input: { agent: 'oracle', task: 'Analyze the codebase structure and identify relevant files.' },
      output: 'Oracle analysis complete: found 3 relevant files in src/auth/',
    },
  },
};

export const OMOC_DELEGATE_LIBRARIAN = {
  type: 'tool_use',
  timestamp: 1773304962000,
  sessionID: 'ses_omoc_test',
  part: {
    type: 'tool',
    callID: 'toolu_delegate_2',
    tool: 'delegate-task',
    state: {
      status: 'completed',
      input: { agent: 'librarian', task: 'Look up the API documentation for the auth middleware.' },
      output: 'Documentation found in docs/api/auth.md',
    },
  },
};

export const OMOC_DELEGATE_FRONTEND = {
  type: 'tool_use',
  timestamp: 1773304964000,
  sessionID: 'ses_omoc_test',
  part: {
    type: 'tool',
    callID: 'toolu_delegate_3',
    tool: 'delegate-task',
    state: {
      status: 'completed',
      input: { agent: 'frontend-engineer', task: 'Implement the login form component.' },
      output: 'Component created at src/components/LoginForm.tsx',
    },
  },
};

export const OMOC_BASH_TOOL = {
  type: 'tool_use',
  timestamp: 1773304966000,
  sessionID: 'ses_omoc_test',
  part: {
    type: 'tool',
    callID: 'toolu_bash_1',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'cat src/auth/middleware.ts', description: 'Read auth middleware' },
      output: 'export function authMiddleware() { ... }',
    },
  },
};

export const OMOC_STEP_FINISH = {
  type: 'step_finish',
  timestamp: 1773304970000,
  sessionID: 'ses_omoc_test',
  part: {
    type: 'step-finish',
    reason: 'stop',
    cost: 0.108,
    tokens: { total: 36937, input: 36500, output: 437, reasoning: 0 },
  },
};

export const OPENCODE_INTERNAL_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'delegate-task',
  'list-sessions',
  'webfetch',
  'todoreplace',
];

export const OMOC_INTERNAL_AGENTS = [
  'oracle',
  'librarian',
  'frontend-engineer',
  'backend-engineer',
  'devops-engineer',
  'qa-engineer',
];
