'use client';

import { useCallback, useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';
import { CompanionCard, type CompanionCardModel, cardAction } from './ChatVoiceFeatureControlsV2Card';
import { HeadphonesIcon } from './icons/HeadphonesIcon';
import { MicIcon } from './icons/MicIcon';
import { InstallPreviewModal } from './settings/InstallPreviewModal';
import { unlockAutoplay } from './VoiceCompanionButton';
import {
  ensureVoiceServiceEnabled,
  FEATURE_SERVICES,
  installVoiceService,
  isServiceReady,
  isServiceStarting,
  readVoiceService,
  type ServiceState,
  type VoiceFeature,
  type VoiceServiceUi,
} from './voice-feature-services';
import type { AudioStatus } from './workspace/audio-transcript-contract';
import { voiceMeetingCopy } from './workspace/voice-meeting.shell-copy';

interface ChatVoiceFeatureControlsProps {
  threadId?: string;
  defaultCatId: string;
  disabled?: boolean;
}

type Copy = (typeof voiceMeetingCopy)['zh'];

/**
 * What a card can honestly say about the feature's backing service, from `/api/services` alone: a fixed install
 * estimate is labelled as an estimate (gap-list #1), a startup failure quotes the service's own error and opens the
 * real logs, and nothing is counted down (no live progress exists in the contract).
 */
type ServiceView =
  | { kind: 'ready' }
  | { kind: 'unknown' }
  | { kind: 'busy' }
  | { kind: 'install'; service: ServiceState }
  | { kind: 'not-installable' }
  | { kind: 'failed'; reason: string };

function serviceViewOf(service: ServiceState | null | undefined): ServiceView {
  if (service == null) return { kind: 'unknown' };
  if (!service.installed) {
    return service.installable ? { kind: 'install', service } : { kind: 'not-installable' };
  }
  if (service.status === 'unhealthy' || service.status === 'not_configured') {
    const reason = service.error?.trim();
    return { kind: 'failed', reason: reason && reason !== 'fetch failed' ? reason : '—' };
  }
  if (isServiceStarting(service)) return { kind: 'busy' };
  if (isServiceReady(service) || service.enabled) return { kind: 'ready' };
  return { kind: 'ready' };
}

export function ChatVoiceFeatureControlsV2({ threadId, defaultCatId, disabled }: ChatVoiceFeatureControlsProps) {
  const t = useShellCopy(voiceMeetingCopy);
  const { cats } = useCatData({ fetch: false });
  const [busyFeature, setBusyFeature] = useState<VoiceFeature | null>(null);
  const [installTarget, setInstallTarget] = useState<{ feature: VoiceFeature; service: ServiceState } | null>(null);
  const [services, setServices] = useState<Record<VoiceFeature, ServiceState | null | undefined>>({
    'voice-companion': undefined,
    'audio-capture': undefined,
  });
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const session = useVoiceSessionStore((s) => s.session);
  const startVoice = useVoiceSessionStore((s) => s.start);
  const stopVoice = useVoiceSessionStore((s) => s.stop);
  const pauseAudio = useVoiceSessionStore((s) => s.pauseAudio);
  const resumeAudio = useVoiceSessionStore((s) => s.resumeAudio);
  const skipAudio = useVoiceSessionStore((s) => s.skipAudio);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);
  const setFloatingTranscriptVisible = useChatStore((s) => s.setFloatingTranscriptVisible);

  // The v2 toasts speak the current dictionary language; classic callers of the same helpers keep the classic
  // Chinese defaults and never subscribe to this preference (review P2-4).
  const serviceUi = useCallback(
    (feature: VoiceFeature): VoiceServiceUi => ({
      serviceName: feature === 'voice-companion' ? t.voice.serviceName : t.meeting.serviceName,
      ...t.services,
    }),
    [t],
  );

  const refreshServices = useCallback(async () => {
    const [voice, audio] = await Promise.all([
      readVoiceService('voice-companion').catch(() => null),
      readVoiceService('audio-capture').catch(() => null),
    ]);
    setServices({ 'voice-companion': voice, 'audio-capture': audio });
  }, []);

  // One poll loop drives both producers: the audio session AND the service manager (review P1-1 — a service that
  // finishes installing or gets repaired elsewhere must make its card actionable again without a remount; the
  // interval is cleaned up on unmount).
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await apiFetch('/api/audio/status');
        if (resp.ok && !cancelled) setAudioStatus((await resp.json()) as AudioStatus);
      } catch {
        /* offline — the card keeps its last known state */
      }
      if (!cancelled) await refreshServices();
    };
    void poll();
    const iv = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [refreshServices]);

  const voiceCompanionActive = Boolean(session?.voiceMode && session.boundThreadId === threadId);
  const playbackState = session?.playbackState ?? 'idle';
  const activeCatName = cats.find((cat) => cat.id === session?.activeCatId)?.displayName ?? session?.activeCatId ?? '';
  const audioCapturing = audioStatus?.running === true;
  const audioPaused = audioCapturing && audioStatus?.paused === true;
  const captureInputsLabel = audioStatus?.inputs?.length
    ? audioStatus.inputs.map((input) => input.label ?? input.id).join(' + ')
    : (audioStatus?.app_name ?? (audioStatus?.source === 'mic' ? t.capture.microphone : ''));
  const actionDisabled = disabled || !threadId || busyFeature !== null || installTarget !== null;

  const activate = useCallback(
    async (feature: VoiceFeature) => {
      if (!threadId || actionDisabled) return;
      setBusyFeature(feature);
      try {
        const ready = await ensureVoiceServiceEnabled(feature, serviceUi(feature));
        if (!ready.ready && ready.installRequired) {
          setInstallTarget(ready.installRequired);
          return;
        }
        if (!ready.ready) return;
        if (feature === 'voice-companion') startVoice(threadId, defaultCatId, unlockAutoplay());
        else setRightPanelMode('transcript');
      } finally {
        setBusyFeature(null);
        void refreshServices();
      }
    },
    [actionDisabled, defaultCatId, refreshServices, serviceUi, setRightPanelMode, startVoice, threadId],
  );

  const completeInstall = useCallback(
    async (opts: { model?: string; port?: number }) => {
      const target = installTarget;
      if (!target) return;
      setInstallTarget(null);
      setBusyFeature(target.feature);
      try {
        const installed = await installVoiceService(target.feature, opts, serviceUi(target.feature));
        if (!installed) return;
        const ready = await ensureVoiceServiceEnabled(target.feature, serviceUi(target.feature));
        if (!ready.ready) return;
        if (target.feature === 'audio-capture') setRightPanelMode('transcript');
        else if (threadId) startVoice(threadId, defaultCatId, unlockAutoplay());
      } finally {
        setBusyFeature(null);
        void refreshServices();
      }
    },
    [defaultCatId, installTarget, refreshServices, serviceUi, setRightPanelMode, startVoice, threadId],
  );

  const modelFor = (
    feature: VoiceFeature,
    view: ServiceView,
    words: Copy['voice'] | Copy['meeting'],
  ): CompanionCardModel => {
    const base = {
      feature,
      icon: feature === 'voice-companion' ? <HeadphonesIcon className="h-5 w-5" /> : <MicIcon className="h-5 w-5" />,
      title: words.title,
      label: words.title,
    };
    if (busyFeature === feature || view.kind === 'busy') {
      return { ...base, busy: true, status: <span className="text-cafe-secondary">{words.starting}</span> };
    }
    if (view.kind === 'install') {
      const minutes = view.service.prerequisites?.estimatedMinutes;
      return {
        ...base,
        action: cardAction(
          'primary',
          words.install,
          () => setInstallTarget({ feature, service: view.service }),
          `${feature === 'voice-companion' ? 'voice' : 'meeting'}-companion-install`,
        ),
        status: (
          <span className="text-cafe-secondary">
            {typeof minutes === 'number'
              ? words.notInstalled(words.serviceName, minutes)
              : words.notInstallable(words.serviceName)}
          </span>
        ),
      };
    }
    if (view.kind === 'not-installable') {
      return {
        ...base,
        status: <span className="text-cafe-secondary">{words.notInstallable(words.serviceName)}</span>,
      };
    }
    if (view.kind === 'failed') {
      return {
        ...base,
        status: <span className="text-conn-red-text">{words.startFailed(words.serviceName, view.reason)}</span>,
        logsFeature: feature,
      };
    }
    return { ...base, status: null };
  };

  const voiceModel = ((): CompanionCardModel => {
    if (voiceCompanionActive) {
      const statusLine =
        playbackState === 'playing' ? (
          <span className="text-conn-emerald-text">{t.voice.reading(activeCatName)}</span>
        ) : playbackState === 'paused' ? (
          <span className="text-conn-amber-text">{t.voice.paused}</span>
        ) : (
          <span className="text-cafe-secondary">{t.voice.idle}</span>
        );
      return {
        feature: 'voice-companion',
        icon: <HeadphonesIcon className="h-5 w-5 animate-pulse" />,
        title: t.voice.title,
        label: t.voice.stopLabel,
        active: true,
        action: cardAction('outline', t.voice.stop, stopVoice, 'voice-companion-stop'),
        status: (
          <span className="flex flex-wrap items-center gap-2">
            {statusLine}
            {(playbackState === 'playing' || playbackState === 'paused') && (
              <span className="flex items-center gap-1">
                {cardAction(
                  'outline',
                  playbackState === 'paused' ? t.voice.resume : t.voice.pause,
                  playbackState === 'paused' ? resumeAudio : pauseAudio,
                  'voice-companion-pause-resume',
                )}
                {cardAction('outline', t.voice.skip, skipAudio, 'voice-companion-skip')}
              </span>
            )}
            <span className="basis-full text-cafe-secondary">{t.voice.subtitle}</span>
          </span>
        ),
      };
    }
    const model = modelFor('voice-companion', serviceViewOf(services['voice-companion']), t.voice);
    if (model.status !== null) return model;
    return {
      ...model,
      action: cardAction(
        'primary',
        t.voice.start,
        () => void activate('voice-companion'),
        'voice-companion-start',
        actionDisabled,
      ),
      status: <span className="text-cafe-secondary">{t.voice.subtitle}</span>,
    };
  })();

  const meetingModel = ((): CompanionCardModel => {
    if (audioCapturing) {
      return {
        feature: 'audio-capture',
        icon: <MicIcon className="h-5 w-5" />,
        title: t.meeting.title,
        label: t.meeting.title,
        active: !audioPaused,
        onTitleClick: () => setRightPanelMode('transcript'),
        // 弹出成浮窗 actually pops out (review P2-3): the label and the destination now match.
        action: cardAction(
          'outline',
          t.capture.popOut,
          () => setFloatingTranscriptVisible(true),
          'meeting-companion-open',
        ),
        status: audioPaused ? (
          <span className="text-conn-amber-text">{t.capture.paused}</span>
        ) : (
          <span className="text-conn-emerald-text">{t.meeting.capturing(captureInputsLabel)}</span>
        ),
      };
    }
    const model = modelFor('audio-capture', serviceViewOf(services['audio-capture']), t.meeting);
    if (model.status !== null) return model;
    return {
      ...model,
      action: cardAction(
        'primary',
        t.meeting.start,
        () => void activate('audio-capture'),
        'meeting-companion-start',
        actionDisabled,
      ),
      status: <span className="text-cafe-secondary">{t.meeting.notCapturing}</span>,
    };
  })();

  return (
    <>
      <div className="grid gap-2.5" data-testid="workspace-companion-controls">
        <CompanionCard model={voiceModel} t={t} />
        <CompanionCard model={meetingModel} t={t} />
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
