import type {
  CatVoiceResolution,
  ITtsProvider,
  TtsSynthesizeRequest,
  TtsVoiceSelection,
  VoiceConfig,
} from '@cat-cafe/shared';
import { TTS_REFERENCE_UNKNOWN as REFERENCE_UNKNOWN } from '@cat-cafe/shared';
import { resolveCatVoice } from '../../../../config/cat-voices.js';
import { readReferenceContent } from './reference-audio-cache.js';

const referenceWarnings = {
  missing: '参考音频不存在，本次未使用参考音频克隆。',
  unavailable: '参考音频无法读取或准备，本次未使用参考音频克隆。',
  unsupported: '当前语音提供器不支持参考音频克隆，本次未使用参考音频。',
  unverified: REFERENCE_UNKNOWN,
  sent: '',
  verified_cache: '',
  not_requested: '',
};

export function prepareResolvedCatVoice(
  resolved: CatVoiceResolution,
  provider: ITtsProvider,
  overrides: Partial<Pick<VoiceConfig, 'voice' | 'langCode' | 'speed'>> = {},
  _cacheDir?: string,
): { request: Omit<TtsSynthesizeRequest, 'text'>; voiceSelection: TtsVoiceSelection } {
  const { config, ...resolution } = resolved;
  const requested: VoiceConfig = { ...config, ...overrides, speed: overrides.speed ?? config.speed ?? 1 };
  const warnings: string[] = [];
  if (resolution.source === 'global_default') warnings.push('未配置本人声线，本次使用全局默认声音。');
  if (resolution.source === 'breed_default') warnings.push('未配置本人声线，本次使用品种默认声线。');
  if (resolution.source === 'unknown') warnings.push('成员声线配置读取失败，本次声线来源无法确认。');
  if (resolution.envOverride) warnings.push(`声音 ID 被环境设置 ${resolution.envOverride} 覆盖。`);
  const missingTranscript =
    !!requested.refAudio && provider.referenceAudioSupport === true && !requested.refText?.trim();
  const referenceStatus = !requested.refAudio
    ? 'not_requested'
    : provider.referenceAudioSupport === false
      ? 'unsupported'
      : missingTranscript
        ? 'unavailable'
        : 'unverified';
  const content =
    requested.refAudio &&
    provider.referenceAudioSupport !== false &&
    !missingTranscript &&
    (provider.referenceAudioContentSupport || provider.cacheOnly)
      ? readReferenceContent(requested.refAudio)
      : undefined;
  let effective = requested;
  const referenceWarning = referenceWarnings[referenceStatus];
  if (referenceWarning) warnings.push(referenceWarning);
  if (referenceStatus === 'unsupported' || missingTranscript) {
    const { refAudio: _audio, refText: _text, instruct: _instruct, temperature: _temperature, ...fallback } = requested;
    effective = fallback;
    if (missingTranscript) warnings.push('参考音频缺少对应转写，本次未使用参考音频克隆。');
  }
  if (!effective.refAudio && provider.voiceIdSupport === false) {
    warnings.push('当前提供器不按声音 ID 选音色，本次没有参考音频，使用模型默认音色。');
  } else if (!effective.refAudio && resolution.source === 'cat_config' && provider.voiceIdSupport == null) {
    warnings.push('当前没有参考音频，提供器是否按声音 ID 选音色尚未确认。');
  }
  return {
    request: { ...effective, format: 'wav', ...(content ? { refAudioData: content } : {}) },
    voiceSelection: {
      ...resolution,
      provider: provider.id,
      model: provider.model,
      requested,
      effective,
      referenceStatus: missingTranscript ? 'unavailable' : referenceStatus,
      warnings,
      ...(effective.refAudio ? { referenceTransport: content ? 'inline' : 'provider_path' } : {}),
      ...(content ? { referenceInputSha256: content.sha256 } : {}),
    },
  };
}

export function prepareCatVoice(
  catId: string,
  provider: ITtsProvider,
  overrides: Partial<Pick<VoiceConfig, 'voice' | 'langCode' | 'speed'>> = {},
  cacheDir?: string,
) {
  return prepareResolvedCatVoice(resolveCatVoice(catId), provider, overrides, cacheDir);
}

export function cachedVoiceSelection(selection: TtsVoiceSelection): TtsVoiceSelection {
  return selection.effective.refAudio && selection.referenceInputSha256
    ? {
        ...selection,
        referenceStatus: 'verified_cache',
        referenceSha256: selection.referenceInputSha256,
        warnings: selection.warnings.filter((warning) => warning !== REFERENCE_UNKNOWN),
      }
    : selection;
}

/** Generation receipts belong to the actual reader, never today's file-stat projection. */
export function completeVoiceSelection(
  selection: TtsVoiceSelection,
  receipt: import('@cat-cafe/shared').TtsSynthesizeResult['referenceAudio'],
  provider: ITtsProvider,
): TtsVoiceSelection {
  if (!selection.effective.refAudio) return selection;
  if (receipt?.status === 'unavailable') {
    const {
      refAudio: _audio,
      refText: _text,
      instruct: _instruct,
      temperature: _temperature,
      ...effective
    } = selection.effective;
    return {
      ...selection,
      effective,
      referenceStatus: 'unavailable',
      warnings: [
        ...selection.warnings.filter((warning) => warning !== REFERENCE_UNKNOWN),
        referenceWarnings.unavailable,
        ...(provider.voiceIdSupport === false
          ? ['当前提供器不按声音 ID 选音色，本次没有参考音频，使用模型默认音色。']
          : []),
      ],
    };
  }
  const confirmed =
    receipt?.status === 'used' &&
    receipt.sha256 === selection.referenceInputSha256 &&
    selection.referenceTransport === 'inline';
  return {
    ...selection,
    referenceStatus: confirmed ? 'sent' : 'unverified',
    warnings: confirmed ? selection.warnings.filter((warning) => warning !== REFERENCE_UNKNOWN) : selection.warnings,
    ...(receipt?.sha256 ? { referenceSha256: receipt.sha256 } : {}),
  };
}

export { ReferenceAudioChangedError, VoiceSelectionSequence } from '@cat-cafe/shared';
