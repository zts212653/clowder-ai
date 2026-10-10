/**
 * The rule that decides what an envelope looks like on a timeline.
 *
 * It existed as four independent copies — the server timeline projection plus three client
 * hydration paths — and they drifted. #1398 began writing an explicit
 * `from: {kind:'system', service}` on connector notices that previously stored no `from`, so the
 * server synthesized `{kind:'external', connectorId}` from `source` and every copy derived
 * `connector` for free. Only the server copy was taught the explicit form; the client copies kept
 * mapping `system` to `system`, dropped the connector framing, and the hold-ball card degraded to
 * a plain text block.
 *
 * `system + source` is therefore the case worth pinning: it is the one that regressed, and the one
 * a future copy would get wrong again.
 */
import { describe, expect, it } from 'vitest';
import { type MessageFrom, timelineMessageKind } from '../types/message-lifecycle.js';

const SYSTEM_CONNECTOR: MessageFrom = { kind: 'system', service: 'managed-command-wake' };

describe('timelineMessageKind', () => {
  it('treats a system service carrying a connector source as a connector', () => {
    expect(timelineMessageKind(SYSTEM_CONNECTOR, true)).toBe('connector');
  });

  it('treats the same system service with no source as a system message', () => {
    expect(timelineMessageKind(SYSTEM_CONNECTOR, false)).toBe('system');
  });

  it('classifies external and plugin senders as connectors regardless of source', () => {
    expect(timelineMessageKind({ kind: 'external', connectorId: 'telegram' }, false)).toBe('connector');
    expect(timelineMessageKind({ kind: 'plugin', instanceId: 'plug-1' }, false)).toBe('connector');
  });

  it('classifies agents and users by sender identity', () => {
    expect(timelineMessageKind({ kind: 'agent', catId: 'opus' }, false)).toBe('assistant');
    expect(timelineMessageKind({ kind: 'user', userId: 'default-user' }, false)).toBe('user');
  });

  it('a source never overrides an agent or user sender', () => {
    expect(timelineMessageKind({ kind: 'agent', catId: 'opus' }, true)).toBe('assistant');
    expect(timelineMessageKind({ kind: 'user', userId: 'default-user' }, true)).toBe('user');
  });

  it('declines to decide when the envelope names no sender, so callers keep their own fallback', () => {
    expect(timelineMessageKind(undefined, true)).toBeNull();
    expect(timelineMessageKind(undefined, false)).toBeNull();
  });
});
