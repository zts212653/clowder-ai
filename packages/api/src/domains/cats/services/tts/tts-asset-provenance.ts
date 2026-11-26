import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsVoiceSelection } from '@cat-cafe/shared';
import { cachedVoiceSelection } from './cat-voice-synthesis.js';

const ASSET = /^[a-f0-9]{64}\.(wav|mp3)$/;

export interface AssetVoiceReceipt {
  voiceSelection: TtsVoiceSelection;
  reusable: boolean;
}

export async function readAssetVoiceReceipt(cacheDir: string, assetId: string): Promise<AssetVoiceReceipt | undefined> {
  if (!ASSET.test(assetId)) return undefined;
  try {
    const value = JSON.parse(
      await readFile(join(cacheDir, `${assetId}.voice.json`), 'utf8'),
    ) as Partial<AssetVoiceReceipt>;
    const voice = value.voiceSelection;
    if (
      typeof value.reusable !== 'boolean' ||
      !voice ||
      typeof voice.catId !== 'string' ||
      !voice.requested ||
      !voice.effective ||
      typeof voice.effective.voice !== 'string' ||
      !Array.isArray(voice.warnings) ||
      !voice.warnings.every((warning) => typeof warning === 'string')
    )
      return undefined;
    return { voiceSelection: voice, reusable: value.reusable };
  } catch {
    return undefined;
  }
}

/** A retained document recording is playable without proving today's input. */
export async function readListenRecording(cacheDir: string, assetId: string, bytes: number) {
  const receipt = await readAssetVoiceReceipt(cacheDir, assetId);
  const historicalNotice = '正在回放文档已存录音；声线信息来自生成时回执，当前参考内容未重新核验。';
  const voiceSelection = receipt?.voiceSelection;
  const confirmed =
    receipt?.reusable &&
    !!voiceSelection?.referenceInputSha256 &&
    voiceSelection?.referenceStatus === 'sent' &&
    voiceSelection.referenceSha256 === voiceSelection.referenceInputSha256;
  return {
    audioUrl: `/api/tts/audio/${assetId}`,
    assetId,
    bytes,
    cached: true,
    historical: true as const,
    ...(voiceSelection
      ? {
          voiceSelection: {
            ...(confirmed ? cachedVoiceSelection(voiceSelection) : voiceSelection),
            warnings: [...voiceSelection.warnings, historicalNotice],
          },
        }
      : {
          warnings: ['此文档保留的历史录音没有声线回执，继续回放时无法确认它对应当前所选声线。'],
        }),
  };
}

/** Cache lookup is about this exact prepared content, not a path's prior receipt. */
export async function canReuseVoiceAsset(
  cacheDir: string,
  assetId: string,
  current: TtsVoiceSelection,
): Promise<boolean> {
  if (!current.effective.refAudio) return true;
  if (!current.referenceInputSha256) return false;
  const receipt = await readAssetVoiceReceipt(cacheDir, assetId);
  return (
    receipt?.reusable === true &&
    receipt.voiceSelection.referenceStatus === 'sent' &&
    receipt.voiceSelection.referenceSha256 === current.referenceInputSha256 &&
    receipt.voiceSelection.referenceInputSha256 === current.referenceInputSha256
  );
}

export async function writeAssetVoiceReceipt(
  cacheDir: string,
  assetId: string,
  voiceSelection: TtsVoiceSelection,
  reusable: boolean,
): Promise<void> {
  if (!ASSET.test(assetId)) throw new Error('Invalid TTS asset identity');
  const destination = join(cacheDir, `${assetId}.voice.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ voiceSelection, reusable }), { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Explicit historical playback is allowed; this only gates a current-voice cache link. */
export async function canLinkReusableAsset(cacheDir: string, assetId: string): Promise<boolean> {
  const receipt = await readAssetVoiceReceipt(cacheDir, assetId);
  const voice = receipt?.voiceSelection;
  return (
    receipt?.reusable === true &&
    !!voice &&
    (!voice.effective.refAudio ||
      (voice.referenceStatus === 'sent' &&
        !!voice.referenceInputSha256 &&
        voice.referenceInputSha256 === voice.referenceSha256))
  );
}
