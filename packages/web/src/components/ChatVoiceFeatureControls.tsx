'use client';

import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { type PlaybackState, useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';
import { HeadphonesIcon } from './icons/HeadphonesIcon';
import { MicIcon } from './icons/MicIcon';
import { unlockAutoplay } from './VoiceCompanionButton';

type VoiceFeature = 'voice-companion' | 'audio-capture';

interface ServiceState {
  id: string;
  installed: boolean;
  enabled: boolean;
  installable: boolean;
}

const FEATURE_SERVICES: Record<VoiceFeature, { serviceId: string; serviceLabel: string }> = {
  'voice-companion': { serviceId: 'mlx-tts', serviceLabel: '语音合成' },
  'audio-capture': { serviceId: 'audio-capture', serviceLabel: '音频采集' },
};

interface ChatVoiceFeatureControlsProps {
  threadId?: string;
  defaultCatId: string;
  disabled?: boolean;
}

function toastServiceMissing(feature: VoiceFeature) {
  const { serviceLabel } = FEATURE_SERVICES[feature];
  useToastStore.getState().addToast({
    type: 'info',
    title: `${serviceLabel}未安装`,
    message: `请到设置 → 语音管理安装并启用${serviceLabel}服务。`,
    duration: 6000,
  });
}

function toastServiceError(feature: VoiceFeature, message: string) {
  const { serviceLabel } = FEATURE_SERVICES[feature];
  useToastStore.getState().addToast({
    type: 'error',
    title: `${serviceLabel}启用失败`,
    message,
    duration: 6000,
  });
}

async function ensureVoiceServiceEnabled(feature: VoiceFeature): Promise<boolean> {
  const { serviceId, serviceLabel } = FEATURE_SERVICES[feature];
  try {
    const servicesRes = await apiFetch('/api/services');
    if (!servicesRes.ok) {
      toastServiceError(feature, `无法读取${serviceLabel}服务状态。`);
      return false;
    }
    const servicesPayload = (await servicesRes.json().catch(() => ({}))) as { services?: ServiceState[] };
    const service = servicesPayload.services?.find((item) => item.id === serviceId);
    if (!service?.installed) {
      toastServiceMissing(feature);
      return false;
    }
    if (service.enabled) return true;
    if (!service.installable) return true;

    const enableRes = await apiFetch(`/api/services/${serviceId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const enablePayload = (await enableRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!enableRes.ok || enablePayload.ok === false) {
      toastServiceError(feature, enablePayload.error ?? `无法启用${serviceLabel}服务。`);
      return false;
    }
    return true;
  } catch {
    toastServiceError(feature, `无法连接${serviceLabel}服务管理接口。`);
    return false;
  }
}

function VoicePlaybackControls({ playbackState }: { playbackState: PlaybackState }) {
  const pauseAudio = useVoiceSessionStore((s) => s.pauseAudio);
  const resumeAudio = useVoiceSessionStore((s) => s.resumeAudio);
  const skipAudio = useVoiceSessionStore((s) => s.skipAudio);
  const isPaused = playbackState === 'paused';

  return (
    <>
      <button
        type="button"
        onClick={isPaused ? resumeAudio : pauseAudio}
        className="p-1 rounded-lg text-conn-emerald-text hover:bg-[var(--console-hover-bg)] transition-colors"
        aria-label={isPaused ? '继续播放' : '暂停'}
        title={isPaused ? '继续播放' : '暂停'}
      >
        {isPaused ? (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={skipAudio}
        className="p-1 rounded-lg text-conn-emerald-text hover:bg-[var(--console-hover-bg)] transition-colors"
        aria-label="跳过当前"
        title="跳过当前"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </>
  );
}

export function ChatVoiceFeatureControls({ threadId, defaultCatId, disabled }: ChatVoiceFeatureControlsProps) {
  const [busyFeature, setBusyFeature] = useState<VoiceFeature | null>(null);
  const session = useVoiceSessionStore((s) => s.session);
  const startVoice = useVoiceSessionStore((s) => s.start);
  const stopVoice = useVoiceSessionStore((s) => s.stop);
  const rightPanelMode = useChatStore((s) => s.rightPanelMode);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);

  const voiceCompanionActive = Boolean(session?.voiceMode && session.boundThreadId === threadId);
  const playbackState = session?.playbackState ?? 'idle';
  const audioCaptureActive = rightPanelMode === 'transcript';
  const actionDisabled = disabled || !threadId || busyFeature !== null;

  const activateVoiceCompanion = useCallback(async () => {
    if (!threadId || actionDisabled) return;
    if (voiceCompanionActive) {
      stopVoice();
      return;
    }
    setBusyFeature('voice-companion');
    try {
      const ready = await ensureVoiceServiceEnabled('voice-companion');
      if (!ready) return;
      startVoice(threadId, defaultCatId, unlockAutoplay());
    } finally {
      setBusyFeature(null);
    }
  }, [actionDisabled, defaultCatId, startVoice, stopVoice, threadId, voiceCompanionActive]);

  const activateAudioCapture = useCallback(async () => {
    if (!threadId || actionDisabled) return;
    if (audioCaptureActive) {
      setRightPanelMode('status');
      return;
    }
    setBusyFeature('audio-capture');
    try {
      const ready = await ensureVoiceServiceEnabled('audio-capture');
      if (!ready) return;
      setRightPanelMode('transcript');
    } finally {
      setBusyFeature(null);
    }
  }, [actionDisabled, audioCaptureActive, setRightPanelMode, threadId]);

  const buttonClass = (active: boolean, busy: boolean) =>
    `flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
      active
        ? 'text-conn-emerald-text bg-conn-emerald-bg hover:opacity-80'
        : 'bg-transparent text-cafe-secondary hover:text-cafe-accent'
    } ${busy ? 'animate-pulse' : ''}`;

  return (
    <div className="flex items-center gap-0.5">
      {voiceCompanionActive && (playbackState === 'playing' || playbackState === 'paused') && (
        <VoicePlaybackControls playbackState={playbackState} />
      )}
      <button
        type="button"
        onClick={activateVoiceCompanion}
        disabled={actionDisabled}
        className={buttonClass(voiceCompanionActive, busyFeature === 'voice-companion')}
        aria-label={voiceCompanionActive ? '停止语音陪伴' : '语音陪伴'}
        title={voiceCompanionActive ? '停止语音陪伴' : '语音陪伴'}
      >
        <HeadphonesIcon className={`w-4 h-4${voiceCompanionActive ? ' animate-pulse' : ''}`} />
      </button>
      <button
        type="button"
        onClick={activateAudioCapture}
        disabled={actionDisabled}
        className={buttonClass(audioCaptureActive, busyFeature === 'audio-capture')}
        aria-label={audioCaptureActive ? '关闭音频采集' : '音频采集'}
        title={audioCaptureActive ? '关闭音频采集' : '音频采集'}
      >
        <MicIcon className="w-4 h-4" />
      </button>
    </div>
  );
}
