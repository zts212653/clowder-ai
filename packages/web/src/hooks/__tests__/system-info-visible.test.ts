import { describe, expect, it } from 'vitest';
import { formatSessionSealRequested } from '../system-info-visible';

describe('formatSessionSealRequested', () => {
  it('describes runtime replacement as an in-turn recovery instead of a context seal', () => {
    expect(
      formatSessionSealRequested(
        {
          type: 'session_seal_requested',
          catId: 'codex-sol',
          sessionSeq: 2,
          reason: 'cli_session_replaced',
          continuityDiagnostics: {
            source: 'runtime_replacement',
            boundary: 'runtime_replacement',
          },
        },
        () => '缅因猫 Sol',
      ),
    ).toEqual({
      content: '缅因猫 Sol 的会话 #2 已自动接力；新会话已在本轮继续运行',
      variant: 'info',
    });
  });

  it('keeps context percentage copy for a real threshold seal', () => {
    expect(
      formatSessionSealRequested(
        {
          type: 'session_seal_requested',
          catId: 'codex-sol',
          sessionSeq: 3,
          reason: 'context_threshold',
          healthSnapshot: { fillRatio: 0.82 },
        },
        () => '缅因猫 Sol',
      ),
    ).toEqual({
      content: '缅因猫 Sol 的会话 #3 已封存（上下文 82%），下次调用将自动创建新会话',
      variant: 'info',
    });
  });
});
