'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  INSTALL_TIMEOUT_MS,
  mutationRequestOptions,
} from '@/components/settings/plugin-manager/plugin-manager-mutation-options';
import { adaptServiceState, type HomeServiceState } from '@/components/settings/service-ui-adapter';
import { unlockAutoplay } from '@/components/voice-autoplay';
import type {
  AudioSources,
  AudioSseEvent,
  AudioStatus,
  TranscriptLine,
} from '@/components/workspace/audio-transcript-contract';
import { useVadInterrupt } from '@/hooks/useVadInterrupt';
import { useVoiceAutoPlay } from '@/hooks/useVoiceAutoPlay';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import type { useWorkspace } from '@/hooks/useWorkspace';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { useVoiceSettingsStore } from '@/stores/voiceSettingsStore';
import { API_URL } from '@/utils/api-client';
import { request, write } from './owner-api';

interface ShareIntent {
  callId: string;
  generation: number;
  captureThreadId: string;
  meetingId: string;
  captureStartedAt: number;
  inputId: string;
  inputLabel: string;
}
type MeetingShare =
  | { kind: 'unavailable' }
  | { kind: 'available'; intent: ShareIntent; catId: string; inputLabel: string; sharing: boolean };
interface Call {
  callId: string;
  threadId: string;
  catId: string;
  state: 'preparing' | 'ready' | 'connecting' | 'talking' | 'closed' | 'failed';
  answer?: string;
}
interface AudioRead {
  status: AudioStatus & { meeting_id?: string; advisory_mode?: 'passive' | 'active' };
  sources: AudioSources;
  lines: TranscriptLine[];
  share: MeetingShare;
  load: string;
}
interface StopSummary {
  transcript_path?: string;
  recording_path?: string;
  recording_paths?: Record<string, string>;
}
interface ServiceInstallPreview {
  profile: {
    os: string;
    arch: string;
    gpu: string;
    gpuDetail?: string;
    ramGb: number;
    diskFreeGb: number;
    pythonVersion?: string;
    pythonArch: string;
  };
  recommendation: {
    models: { name: string; description: string }[];
    customModelHint?: { requirement: string };
    unsupported?: { reason: string };
  };
  suggestedPort: number;
}
export function sourceOptions(sources: AudioSources) {
  return [
    ...sources.mics.map((x) => ({
      id: `mic:${x.index}`,
      name: x.name,
      input: { id: `mic-${x.index}`, source: 'mic' as const, device: x.index, label: x.name },
    })),
    ...sources.apps.map((x) => ({
      id: `app:${x.id}`,
      name: x.name,
      input: { id: x.id, source: 'app' as const, app_name: x.name, label: x.name },
    })),
  ];
}
export function useVoiceBindings(
  threadId: string,
  target: () => string,
  workspace: ReturnType<typeof useWorkspace>,
  fields: Record<string, unknown>,
  needed: (source: string) => boolean | number,
) {
  const enabled = needed('services') || needed('capture');
  const captureNeeded = needed('capture');
  const session = useVoiceSessionStore((s) => s.session),
    settings = useVoiceSettingsStore((s) => s.settings);
  useVoiceAutoPlay();
  useVoiceStream();
  const vad = useVadInterrupt();
  const [services, setServices] = useState<{ load: string; items: HomeServiceState[] }>({ load: 'loading', items: [] });
  const [installPreviews, setInstallPreviews] = useState<Record<string, ServiceInstallPreview>>({});
  const [capture, setCapture] = useState<AudioRead>({
    status: { running: false },
    sources: { mics: [], apps: [] },
    lines: [],
    share: { kind: 'unavailable' },
    load: 'loading',
  });
  const captureOwner = useRef<string>();
  const captureRead = useRef(0);
  const state = useRef({ sourceId: '', allowHomeReads: false, termEdit: null as number | null });
  const [saved, setSaved] = useState<{ owner: string; summary: StopSummary } | null>(null);
  const [call, setCall] = useState<Call | null>(null),
    callRef = useRef<Call | null>(null);
  callRef.current = call;
  const [transcript, setTranscript] = useState<{ messages: { text: string }[] }>({ messages: [] });
  const [share, setShare] = useState<{ sourceRef: string; sourceLabel: string } | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null),
    mic = useRef<MediaStream | null>(null),
    remote = useRef<HTMLAudioElement | null>(null),
    screen = useRef<MediaStream | null>(null),
    screenTimer = useRef<ReturnType<typeof setInterval>>();
  const epoch = useRef(0),
    [error, setError] = useState('');
  const readServices = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request<{ services: HomeServiceState[] }>('/api/services', { signal });
      if (!signal?.aborted)
        setServices({
          items: result.services.filter((s) => s.category === 'voice' || s.id === 'audio-capture'),
          load: '',
        });
      return result.services;
    } catch (e) {
      if (!signal?.aborted) setServices({ load: 'error', items: [] });
      throw e;
    }
  }, []);
  const readCapture = useCallback(async (signal?: AbortSignal) => {
    const ticket = ++captureRead.current;
    try {
      const [status, lines, sources, share] = await Promise.all([
        request<AudioRead['status']>('/api/audio/status', { signal }),
        request<{ lines: TranscriptLine[] }>('/api/audio/transcript', { signal }),
        request<AudioSources>('/api/audio/sources', { signal }),
        request<MeetingShare>('/api/concierge/meeting-share', { signal }),
      ]);
      if (signal?.aborted || ticket !== captureRead.current) return;
      if (status.running && status.thread_id) captureOwner.current = status.thread_id;
      setCapture({ status, lines: lines.lines, sources, share, load: '' });
      if (!state.current.sourceId) {
        const input = status.inputs?.[0],
          defaultMic = sources.mics.find((m) => m.default) ?? sources.mics[0];
        state.current.sourceId = input
          ? input.source === 'app'
            ? `app:${input.id}`
            : `mic:${input.device}`
          : defaultMic
            ? `mic:${defaultMic.index}`
            : '';
      }
      return status.running;
    } catch (e) {
      if (!signal?.aborted) setCapture((s) => ({ ...s, load: 'error' }));
      throw e;
    }
  }, []);
  const servicesBusy = services.items.some((item) =>
    ['installing', 'starting', 'stopping', 'uninstalling'].includes(item.status),
  );
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const read = () => {
      if (!document.hidden) void readServices(abort.signal).catch(() => {});
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => {
      abort.abort();
      document.removeEventListener('visibilitychange', read);
    };
  }, [enabled, readServices]);
  useEffect(() => {
    if (!enabled || !servicesBusy) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      if (!document.hidden) void readServices(abort.signal).catch(() => {});
    }, 2000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [enabled, servicesBusy, readServices]);
  const captureService = services.items.find((s) => s.id === 'audio-capture');
  const captureAvailable = !!captureService && adaptServiceState(captureService).status === 'running';
  useEffect(() => {
    if (!captureNeeded || !captureAvailable) return;
    const abort = new AbortController();
    let events: EventSource | null = null;
    const connect = () => {
      const stream = new EventSource(`${API_URL}/api/audio/events`, { withCredentials: true });
      events = stream;
      stream.onmessage = (event) => {
        const value = JSON.parse(event.data) as AudioSseEvent;
        if (value.type === 'transcript' && typeof value.ts === 'number' && typeof value.text === 'string') {
          const line = {
            ...value,
            ts: value.ts,
            text: value.text,
            elapsed_s: value.elapsed_s ?? 0,
            chunk_num: value.chunk_num ?? 0,
            asr_latency: value.asr_latency ?? 0,
          };
          setCapture((current) => ({
            ...current,
            lines: [...current.lines.filter((line) => line.ts !== value.ts), line],
          }));
        } else if (value.type === 'status') {
          if (value.status === 'started') {
            captureOwner.current = value.thread_id;
            setSaved(null);
            setCapture((current) => ({
              ...current,
              lines: [],
              status: {
                ...current.status,
                running: true,
                paused: false,
                thread_id: value.thread_id,
                inputs: value.inputs,
                health: value.health ?? current.status.health,
              },
            }));
          } else if (value.status === 'stopped') {
            const owner = value.thread_id ?? captureOwner.current;
            if (owner) setSaved({ owner, summary: value });
            setCapture((current) => ({ ...current, status: { ...current.status, running: false, paused: false } }));
          } else if (value.status === 'paused' || value.status === 'resumed')
            setCapture((current) => ({ ...current, status: { ...current.status, paused: value.status === 'paused' } }));
        } else if (value.type === 'input_status') void status();
      };
      stream.onerror = () => {
        stream.close();
        events = null;
      };
    };
    const full = async () => {
      if (document.hidden) return;
      try {
        await readCapture(abort.signal);
        if (!abort.signal.aborted && !events) connect();
      } catch {
        /* The source exposes its read failure. */
      }
    };
    const status = async () => {
      if (document.hidden) return;
      if (!events) return full();
      try {
        const value = await request<AudioRead['status']>('/api/audio/status', { signal: abort.signal });
        if (!abort.signal.aborted) setCapture((current) => ({ ...current, status: value, load: '' }));
      } catch {
        events?.close();
        events = null;
        if (!abort.signal.aborted) setCapture((current) => ({ ...current, load: 'error' }));
      }
    };
    void full();
    const timer = setInterval(status, 10_000);
    document.addEventListener('visibilitychange', full);
    return () => {
      document.removeEventListener('visibilitychange', full);
      abort.abort();
      clearInterval(timer);
      events?.close();
      ++captureRead.current;
    };
  }, [captureNeeded, captureAvailable, readCapture]);
  useEffect(() => {
    if (!captureNeeded || !capture.status.running) return;
    const abort = new AbortController();
    const read = () => {
      if (!document.hidden)
        void request<MeetingShare>('/api/concierge/meeting-share', { signal: abort.signal })
          .then((share) => {
            if (!abort.signal.aborted) setCapture((current) => ({ ...current, share }));
          })
          .catch(() => {});
    };
    const timer = setInterval(read, 3000);
    document.addEventListener('visibilitychange', read);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [captureNeeded, capture.status.running]);
  const closeTransport = useCallback(() => {
    peer.current?.close();
    peer.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    remote.current?.pause();
    remote.current = null;
    screen.current?.getTracks().forEach((t) => t.stop());
    screen.current = null;
    if (screenTimer.current) clearInterval(screenTimer.current);
  }, []);
  useEffect(
    () => () => {
      epoch.current++;
      const owner = callRef.current;
      if (owner && owner.state !== 'closed')
        void request(`/api/concierge/live/${encodeURIComponent(owner.callId)}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch((error) => console.error('[PDL call teardown]', error));
      closeTransport();
    },
    [closeTransport],
  );
  const connect = useCallback(async (owner: Call) => {
    const stamp = epoch.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (stamp !== epoch.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mic.current = stream;
    const connection = new RTCPeerConnection();
    peer.current = connection;
    for (const track of stream.getTracks()) connection.addTrack(track, stream);
    connection.ontrack = (e) => {
      const audio = new Audio();
      audio.srcObject = e.streams[0];
      remote.current = audio;
      void audio.play().catch(() => setError('请允许浏览器播放呼叫音频'));
    };
    await connection.setLocalDescription(await connection.createOffer());
    if (connection.iceGatheringState !== 'complete')
      await new Promise<void>((resolve) => {
        connection.onicegatheringstatechange = () => {
          if (connection.iceGatheringState === 'complete') resolve();
        };
      });
    if (stamp !== epoch.current) return;
    const next = await write<Call>(`/api/concierge/live/${encodeURIComponent(owner.callId)}/start`, {
      offer: connection.localDescription!.sdp,
    });
    if (stamp !== epoch.current) return;
    await connection.setRemoteDescription({ type: 'answer', sdp: next.answer! });
    setCall(next);
  }, []);
  useEffect(() => {
    if (!call) return;
    const id = call.callId,
      abort = new AbortController();
    let connecting = false;
    const read = async () => {
      if (document.hidden) return;
      const stamp = epoch.current;
      const [next, text] = await Promise.all([
        request<Call>(`/api/concierge/live/${encodeURIComponent(id)}`, { signal: abort.signal }),
        request<typeof transcript>(`/api/concierge/live/${encodeURIComponent(id)}/transcript`, {
          signal: abort.signal,
        }),
      ]);
      if (abort.signal.aborted || stamp !== epoch.current) return;
      setCall(next);
      setTranscript(text);
      if (next.state === 'ready' && !connecting && !peer.current) {
        connecting = true;
        try {
          await connect(next);
        } catch (error) {
          closeTransport();
          throw error;
        }
      }
      if (next.state === 'closed' || next.state === 'failed') {
        closeTransport();
        setCall(null);
        setShare(null);
      }
    };
    const poll = () => {
      void read().catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    };
    const timer = setInterval(poll, 1000);
    document.addEventListener('visibilitychange', poll);
    poll();
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [call?.callId, connect, closeTransport]);
  const action = async (name: string, args: Record<string, string>): Promise<boolean | ServiceInstallPreview> => {
    const store = useVoiceSessionStore.getState();
    switch (name) {
      case 'voiceSession':
        if (args.op === 'stop') store.stop();
        else store.start(threadId, target(), unlockAutoplay());
        return true;
      case 'voicePlayback':
        if (args.op === 'pause') store.pauseAudio();
        else if (args.op === 'resume') store.resumeAudio();
        else store.skipAudio();
        return true;
      case 'voiceSetting':
        if (args.kind === 'language') useVoiceSettingsStore.getState().setLanguage(args.v as '' | 'zh' | 'en');
        else useVoiceSettingsStore.getState().setCustomPrompt(args.v || null);
        return true;
      case 'voiceSettingsReset':
        useVoiceSettingsStore.getState().resetAll();
        return true;
      case 'voiceSettingsRestore': {
        const value = JSON.parse(args.value) as typeof settings;
        const owner = useVoiceSettingsStore.getState();
        owner.resetAll();
        owner.setLanguage(value.language);
        owner.setCustomPrompt(value.customPrompt);
        value.customTerms.forEach((term) => owner.addTerm(term.from, term.to));
        return true;
      }
      case 'voiceInstallRead': {
        const preview = await request<ServiceInstallPreview>(
          `/api/services/${encodeURIComponent(args.id)}/install-preview`,
        );
        setInstallPreviews((previous) => ({ ...previous, [args.id]: preview }));
        return preview;
      }
      case 'voiceTerm':
        if (args.op === 'add') useVoiceSettingsStore.getState().addTerm(args.from, args.to);
        else if (args.op === 'remove') useVoiceSettingsStore.getState().removeTerm(+args.id);
        else useVoiceSettingsStore.getState().updateTerm(+args.id, args.from, args.to);
        return true;
      case 'svcInstall':
      case 'svcStatus':
      case 'voiceService': {
        let id = args.id,
          op = args.op;
        if (name !== 'voiceService') {
          const service = services.items[+args.i];
          if (!service) throw new Error('服务已变化，请刷新');
          id = service.id;
          op = name === 'svcInstall' ? 'install' : args.v === 'running' ? 'start' : 'stop';
        }
        const path = `/api/services/${encodeURIComponent(id)}/${op}`;
        try {
          const receipt = await request<{ ok: boolean; error?: string; output?: string }>(
            path,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(args.port ? { port: Number(args.port) } : {}),
                ...(args.model ? { model: args.model } : {}),
              }),
            },
            op === 'reconfigure' ? { mutationTimeoutMs: INSTALL_TIMEOUT_MS } : mutationRequestOptions(path),
          );
          if (!receipt.ok) throw new Error([receipt.error, receipt.output].filter(Boolean).join('\n'));
        } finally {
          await readServices();
        }
        return true;
      }
      case 'voiceCaptureSource': {
        if (capture.status.running) {
          await action('wsRec', { op: 'stop' });
          state.current.sourceId = args.v;
          await action('wsRec', { op: 'start' });
        } else state.current.sourceId = args.v;
        return true;
      }
      case 'wsRec': {
        const op = args.op || (capture.status.running ? 'stop' : 'start');
        if (['stop', 'pause', 'start'].includes(op) && capture.share.kind === 'available' && capture.share.sharing) {
          await write('/api/concierge/meeting-share', {}, 'DELETE');
          const fact = await request<MeetingShare>('/api/concierge/meeting-share');
          if (fact.kind === 'available' && fact.sharing) throw new Error('会议分享尚未撤回');
        }
        const source = sourceOptions(capture.sources).find((s) => s.id === state.current.sourceId);
        if (op === 'start' && !source) throw new Error('请选择音频来源');
        const owner = capture.status.thread_id;
        const result = await write<{ summary?: StopSummary }>(
          `/api/audio/${op}`,
          op === 'start' ? { thread_id: threadId, inputs: [source!.input] } : {},
        );
        if (op === 'stop' && result.summary && owner) setSaved({ owner, summary: result.summary });
        if (op === 'start') setSaved(null);
        await readCapture();
        return true;
      }
      case 'transcriptCorrect': {
        const line = capture.lines.find((l) => l.chunk_num === +args.lineId);
        if (!line?.speaker_id) throw new Error('说话人不可修改');
        await write('/api/audio/transcript/correct', {
          chunk_num: line.chunk_num,
          speaker_id: line.speaker_id,
          speaker_label: fields[`voice-speaker-${line.chunk_num}`] ?? line.speaker_label,
        });
        await readCapture();
        return true;
      }
      case 'meetingAdvisoryMode':
      case 'meetingDnd':
        await write(
          `/api/audio/${name === 'meetingDnd' ? 'advisory-dnd' : 'advisory-mode'}`,
          name === 'meetingDnd' ? {} : { mode: args.v },
        );
        await readCapture();
        return true;
      case 'meetingShare':
        if (args.op === 'preview') {
          await readCapture();
          return true;
        }
        if (capture.share.kind !== 'available') throw new Error('会议分享不可用');
        await write(
          '/api/concierge/meeting-share',
          args.op === 'stop' ? {} : capture.share.intent,
          args.op === 'stop' ? 'DELETE' : 'POST',
        );
        await readCapture();
        return true;
      case 'liveCall':
        if (args.op === 'prepare') {
          setError('');
          const stamp = epoch.current,
            next = await write<Call>('/api/concierge/live', { allowHomeReads: state.current.allowHomeReads });
          if (stamp !== epoch.current) {
            await write(`/api/concierge/live/${encodeURIComponent(next.callId)}`, {}, 'DELETE');
            return true;
          }
          setCall(next);
        } else {
          const current = callRef.current;
          if (!current) return true;
          const result = await write<{ stopped: boolean }>(
            `/api/concierge/live/${encodeURIComponent(current.callId)}`,
            {},
            'DELETE',
          );
          if (!result.stopped) throw new Error('呼叫结束尚未确认');
          epoch.current++;
          closeTransport();
          setCall(null);
          setShare(null);
        }
        return true;
      case 'liveCallText': {
        const current = callRef.current;
        if (!current) throw new Error('呼叫已结束');
        await write(`/api/concierge/live/${encodeURIComponent(current.callId)}/text`, {
          text: args.text || args.v,
          clientMessageId: crypto.randomUUID(),
        });
        fields['live-text'] = '';
        return true;
      }
      case 'liveShare': {
        const current = callRef.current;
        if (!current) throw new Error('呼叫已结束');
        const path = `/api/concierge/live/${encodeURIComponent(current.callId)}/screen`;
        if (args.op === 'stop') {
          const result = await write<{ accepted: boolean }>(path, { kind: 'close' });
          if (!result.accepted) throw new Error('停止共享尚未确认');
          screen.current?.getTracks().forEach((t) => t.stop());
          screen.current = null;
          clearInterval(screenTimer.current);
          setShare(null);
          return true;
        }
        if (screen.current) await action('liveShare', { op: 'stop' });
        const stamp = epoch.current;
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (stamp !== epoch.current) {
          stream.getTracks().forEach((t) => t.stop());
          return true;
        }
        const track = stream.getVideoTracks()[0],
          selectionId = crypto.randomUUID();
        const result = await write<{ accepted: boolean }>(path, { kind: 'open', selectionId, label: track.label });
        if (!result.accepted) {
          stream.getTracks().forEach((t) => t.stop());
          throw new Error('共享未授权');
        }
        if (stamp !== epoch.current) {
          stream.getTracks().forEach((t) => t.stop());
          return true;
        }
        screen.current = stream;
        setShare({ sourceRef: selectionId, sourceLabel: track.label });
        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        let sending = false;
        screenTimer.current = setInterval(() => {
          if (sending || !video.videoWidth) return;
          sending = true;
          const scale = Math.min(1, 1600 / video.videoWidth, 1600 / video.videoHeight),
            canvas = document.createElement('canvas');
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
          void write(path, {
            kind: 'frame',
            selectionId,
            frame: {
              image: canvas.toDataURL('image/jpeg', 0.6),
              width: canvas.width,
              height: canvas.height,
              frameId: crypto.randomUUID(),
              sourceLabel: track.label,
              observedAt: Date.now(),
            },
          })
            .catch((e) => setError(e.message))
            .finally(() => {
              sending = false;
            });
        }, 1000);
        track.onended = () => {
          void action('liveShare', { op: 'stop' }).catch((e) => setError(e.message));
        };
        return true;
      }
      case 'refresh':
        if (args.k === 'voice') {
          const observed = await readServices();
          const capture = observed.find((s) => s.id === 'audio-capture');
          if (capture && adaptServiceState(capture).status === 'running') await readCapture();
          return true;
        }
        return false;
      default:
        return false;
    }
  };
  const rawData = useMemo(
    () => ({
      threadId,
      session: session && {
        ...session,
        playedBlockIds: [...session.playedBlockIds],
        liveStreamedInvocationIds: [...session.liveStreamedInvocationIds],
      },
      settings,
      vadState: vad.vadState,
      worktrees: workspace.worktrees.map(({ id, root }) => ({ id, root })),
      services,
      installPreviews,
      capture,
      saved,
      call,
      transcript,
      share,
      error,
    }),
    [
      threadId,
      session,
      settings,
      vad.vadState,
      workspace.worktrees,
      services,
      installPreviews,
      capture,
      saved,
      call,
      transcript,
      share,
      error,
    ],
  );
  return {
    action,
    state: state.current,
    data: rawData,
  };
}
