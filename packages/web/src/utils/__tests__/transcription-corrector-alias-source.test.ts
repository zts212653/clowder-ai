import { describe, expect, it } from 'vitest';

describe('transcription-corrector alias source', () => {
  it('picks up mention aliases after refreshSpeechAliases()', async () => {
    const { correctTranscription, refreshSpeechAliases } = await import('@/utils/transcription-corrector');
    // Before refresh: no aliases → no correction
    expect(correctTranscription('at测试缅因别名 出来一下')).toBe('at测试缅因别名 出来一下');

    // After refresh with dynamic cat data → corrects
    refreshSpeechAliases([{ mentionPatterns: ['@测试缅因别名', '@codex'] }]);
    expect(correctTranscription('at测试缅因别名 出来一下')).toBe('@测试缅因别名 出来一下');
  });
});
