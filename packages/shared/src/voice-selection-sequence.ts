import type { TtsVoiceSelection } from './types/tts.js';

export const TTS_REFERENCE_UNKNOWN = '实际读取端尚未确认参考内容，本次不能确认是本人声线；参考相关音频不自动复用。';

export class ReferenceAudioChangedError extends Error {
  constructor() {
    super('参考音频在同一任务中发生变化，已停止后续语音。');
  }
}

function combineVoiceSelections(
  previous: TtsVoiceSelection | undefined,
  current: TtsVoiceSelection,
): TtsVoiceSelection {
  if (!previous) return current;
  if (previous.referenceStatus === current.referenceStatus && previous.referenceSha256 === current.referenceSha256)
    return current;
  const { referenceSha256: _digest, ...selection } = current;
  return {
    ...selection,
    referenceStatus: 'unverified',
    warnings: [...new Set([...previous.warnings, ...current.warnings, TTS_REFERENCE_UNKNOWN])],
  };
}

/** Evidence memory is independent of the public aggregate's unknown status. */
export class VoiceSelectionSequence {
  private knownSha256?: string;
  private usedReference?: boolean;
  private aggregate?: TtsVoiceSelection;

  observe(current: TtsVoiceSelection): TtsVoiceSelection {
    const used = current.referenceSha256 ? true : current.referenceStatus === 'unavailable' ? false : undefined;
    if (
      (used !== undefined && this.usedReference !== undefined && used !== this.usedReference) ||
      (current.referenceSha256 && this.knownSha256 && current.referenceSha256 !== this.knownSha256)
    )
      throw new ReferenceAudioChangedError();
    if (used !== undefined) this.usedReference = used;
    if (current.referenceSha256) this.knownSha256 = current.referenceSha256;
    this.aggregate = combineVoiceSelections(this.aggregate, current);
    return this.aggregate;
  }
}
