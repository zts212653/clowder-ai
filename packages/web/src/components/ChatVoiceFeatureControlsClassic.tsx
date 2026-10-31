'use client';

import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { type PlaybackState, useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { HeadphonesIcon } from './icons/HeadphonesIcon';
import { MicIcon } from './icons/MicIcon';
import { InstallPreviewModal } from './settings/InstallPreviewModal';
import { unlockAutoplay } from './VoiceCompanionButton';
import {
  ensureVoiceServiceEnabled,
  FEATURE_SERVICES,
  installVoiceService,
  type ServiceState,
  type VoiceFeature,
} from './voice-feature-services';

interface ChatVoiceFeatureControlsProps {
  threadId?: string;
  defaultCatId: string;
  disabled?: boolean;
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

export function ChatVoiceFeatureControlsClassic({ threadId, defaultCatId, disabled }: ChatVoiceFeatureControlsProps) {
  const [busyFeature, setBusyFeature] = useState<VoiceFeature | null>(null);
  const [installTarget, setInstallTarget] = useState<{ feature: VoiceFeature; service: ServiceState } | null>(null);
  const session = useVoiceSessionStore((s) => s.session);
  const startVoice = useVoiceSessionStore((s) => s.start);
  const stopVoice = useVoiceSessionStore((s) => s.stop);
  const rightPanelMode = useChatStore((s) => s.rightPanelMode);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);

  const voiceCompanionActive = Boolean(session?.voiceMode && session.boundThreadId === threadId);
  const playbackState = session?.playbackState ?? 'idle';
  const audioCaptureActive = rightPanelMode === 'transcript';
  const actionDisabled = disabled || !threadId || busyFeature !== null || installTarget !== null;

  const activateVoiceCompanion = useCallback(async () => {
    if (!threadId || actionDisabled) return;
    if (voiceCompanionActive) {
      stopVoice();
      return;
    }
    setBusyFeature('voice-companion');
    try {
      const ready = await ensureVoiceServiceEnabled('voice-companion');
      if (!ready.ready && ready.installRequired) {
        setInstallTarget(ready.installRequired);
        return;
      }
      if (!ready.ready) return;
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
      if (!ready.ready && ready.installRequired) {
        setInstallTarget(ready.installRequired);
        return;
      }
      if (!ready.ready) return;
      setRightPanelMode('transcript');
    } finally {
      setBusyFeature(null);
    }
  }, [actionDisabled, audioCaptureActive, setRightPanelMode, threadId]);

  const completeInstall = useCallback(
    async (opts: { model?: string; port?: number }) => {
      const target = installTarget;
      if (!target) return;
      setInstallTarget(null);
      setBusyFeature(target.feature);
      try {
        const installed = await installVoiceService(target.feature, opts);
        if (!installed) return;
        if (target.feature === 'audio-capture') {
          const ready = await ensureVoiceServiceEnabled(target.feature);
          if (ready.ready) setRightPanelMode('transcript');
          return;
        }
        if (!threadId) return;
        const ready = await ensureVoiceServiceEnabled(target.feature);
        if (ready.ready) {
          startVoice(threadId, defaultCatId, unlockAutoplay());
        }
      } finally {
        setBusyFeature(null);
      }
    },
    [defaultCatId, installTarget, setRightPanelMode, startVoice, threadId],
  );

  const cardClass = (active: boolean, busy: boolean) =>
    `group flex min-h-20 w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-[border-color,background-color,transform] disabled:cursor-not-allowed disabled:opacity-30 ${
      active
        ? 'border-[var(--semantic-success)]/30 bg-conn-emerald-bg text-conn-emerald-text'
        : 'border-cafe-subtle/75 bg-[var(--console-card-bg)] text-cafe-secondary hover:-translate-y-px hover:border-cafe-accent/35 hover:bg-cafe-surface'
    } ${busy ? 'animate-pulse' : ''}`;

  return (
    <>
      <div
        className="grid gap-2.5"
        data-testid="workspace-companion-controls"
        data-layout="panel-auto-fit"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))' }}
      >
        <div className="relative">
          <button
            type="button"
            onClick={activateVoiceCompanion}
            disabled={actionDisabled}
            className={cardClass(voiceCompanionActive, busyFeature === 'voice-companion')}
            aria-label={voiceCompanionActive ? '停止语音陪伴' : '语音陪伴'}
            title={voiceCompanionActive ? '停止语音陪伴' : '语音陪伴'}
            data-testid="workspace-companion-voice"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cafe-accent/10 text-cafe-accent">
              <HeadphonesIcon className={`h-5 w-5${voiceCompanionActive ? ' animate-pulse' : ''}`} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold tracking-tight text-cafe-black">语音陪伴</span>
              <span className="mt-0.5 block text-micro leading-4 text-cafe-secondary">
                {voiceCompanionActive ? '正在陪伴，点此结束' : '让当前猫猫朗读后续回复'}
              </span>
            </span>
            <FeatureArrow />
          </button>
          {voiceCompanionActive && (playbackState === 'playing' || playbackState === 'paused') && (
            <div className="absolute bottom-1.5 right-8 flex items-center gap-0.5">
              <VoicePlaybackControls playbackState={playbackState} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={activateAudioCapture}
          disabled={actionDisabled}
          className={cardClass(audioCaptureActive, busyFeature === 'audio-capture')}
          aria-label={audioCaptureActive ? '关闭会议伴随' : '会议伴随'}
          title={audioCaptureActive ? '关闭会议伴随' : '会议伴随'}
          data-testid="workspace-companion-meeting"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cafe-accent/10 text-cafe-accent">
            <MicIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-tight text-cafe-black">会议伴随</span>
            <span className="mt-0.5 block text-micro leading-4 text-cafe-secondary">
              {audioCaptureActive ? '正在采集，点此关闭' : '打开实时录音与会议转写'}
            </span>
          </span>
          <FeatureArrow />
        </button>
      </div>
      {installTarget && (
        <InstallPreviewModal
          open
          serviceId={FEATURE_SERVICES[installTarget.feature].serviceId}
          serviceName={FEATURE_SERVICES[installTarget.feature].serviceLabel}
          estimatedMinutes={installTarget.service.prerequisites?.estimatedMinutes}
          onConfirm={completeInstall}
          onCancel={() => setInstallTarget(null)}
        />
      )}
    </>
  );
}

function FeatureArrow() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 text-cafe-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cafe-accent"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}
