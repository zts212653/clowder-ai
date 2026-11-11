import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HomeServiceState } from '@/components/settings/service-ui-adapter';
import type { useWorkspace } from '@/hooks/useWorkspace';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { useVoiceSettingsStore } from '@/stores/voiceSettingsStore';
import { apiFetch } from '@/utils/api-client';
import { useVoiceBindings } from '../useVoiceBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/hooks/useVoiceAutoPlay', () => ({ useVoiceAutoPlay: () => {} }));
vi.mock('@/hooks/useVoiceStream', () => ({ useVoiceStream: () => {} }));
vi.mock('@/hooks/useVadInterrupt', () => ({ useVadInterrupt: () => ({ vadState: 'inactive' }) }));
vi.mock('@/components/voice-autoplay', () => ({ unlockAutoplay: () => true }));
class Events {
  static current: Events;
  static instances: Events[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Events.current = this;
    Events.instances.push(this);
  }
  close = vi.fn();
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const svc = (id: string, features: string[], status = 'healthy') =>
  ({
    id,
    name: id,
    category: id === 'audio-capture' ? 'audio' : 'voice',
    features,
    status,
    installed: true,
    enabled: true,
    installable: true,
    configured: true,
    endpoint: null,
  }) as HomeServiceState;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const workspace = { worktrees: [{ id: 'wt', root: '/project', branch: 'main', head: 'abc' }] } as ReturnType<
  typeof useWorkspace
>;
let sharing: boolean,
  revokeFails: boolean,
  status: { running: boolean; thread_id?: string; paused?: boolean; advisory_mode?: 'passive' | 'active' };
let services: HomeServiceState[];
let callState: string;
let writes: { path: string; method: string; body: Record<string, unknown> }[];
const intent = {
  callId: 'call',
  generation: 7,
  captureThreadId: 'producer',
  meetingId: 'meeting',
  captureStartedAt: 99,
  inputId: 'mic-2',
  inputLabel: 'Microphone',
};
beforeEach(() => {
  vi.stubGlobal('EventSource', Events);
  Events.instances = [];
  vi.mocked(apiFetch).mockClear();
  writes = [];
  sharing = true;
  revokeFails = false;
  status = { running: true, thread_id: 'producer' };
  services = [
    svc('audio-capture', ['meeting-copilot', 'live-transcript']),
    svc('mlx-tts', ['voice-output', 'voice-companion']),
    svc('whisper-stt', ['voice-input']),
  ];
  callState = 'preparing';
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const path = String(raw),
      method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ path, method, body: JSON.parse(String(init?.body ?? '{}')) });
    if (path === '/api/services') return reply({ services });
    if (path === '/api/audio/status') return reply(status);
    if (path === '/api/audio/sources')
      return reply({ mics: [{ index: 2, name: 'Microphone', default: true }], apps: [] });
    if (path === '/api/audio/transcript')
      return reply({
        lines: [
          {
            ts: 0,
            elapsed_s: 0,
            chunk_num: 4,
            asr_latency: 0,
            text: 'meeting text',
            speaker_id: 'speaker-1',
            speaker_label: 'Speaker 1',
          },
        ],
      });
    if (path === '/api/concierge/meeting-share') {
      if (method === 'DELETE') {
        if (revokeFails) return reply({ error: 'revoke_failed' }, 503);
        sharing = false;
        return reply({ ok: true });
      }
      return reply({ kind: 'available', intent, inputLabel: 'Microphone', sharing, catId: 'codex' });
    }
    if (path === '/api/audio/advisory-mode') {
      status = { ...status, advisory_mode: JSON.parse(String(init!.body)).mode };
      return reply({ ok: true });
    }
    if (path === '/api/audio/advisory-dnd') return reply({ ok: true });
    if (path === '/api/audio/pause') {
      status = { ...status, paused: true };
      return reply({ ok: true });
    }
    if (path === '/api/audio/stop') {
      status = { running: false };
      return reply({
        summary: { transcript_path: '/project/meeting.md', recording_paths: { 'mic-2': '/project/meeting.wav' } },
      });
    }
    if (path === '/api/audio/start') {
      status = { running: true, thread_id: 'consumer' };
      return reply({ ok: true });
    }
    if (path === '/api/audio/transcript/correct') return reply({ ok: true });
    if (path === '/api/concierge/live' && method === 'POST')
      return reply({ callId: 'call-owner', threadId: 'owner-thread', catId: 'owner-cat', state: callState });
    if (path === '/api/concierge/live/call-owner/start') {
      callState = 'talking';
      return reply({
        callId: 'call-owner',
        threadId: 'owner-thread',
        catId: 'owner-cat',
        state: callState,
        answer: 'native-answer',
      });
    }
    if (path === '/api/concierge/live/call-owner/screen') return reply({ accepted: true });
    if (path === '/api/concierge/live/call-owner/transcript') return reply({ messages: [] });
    if (path === '/api/concierge/live/call-owner/text') return reply({ accepted: true });
    if (path === '/api/concierge/live/call-owner')
      return method === 'DELETE'
        ? reply({ stopped: true })
        : reply({ callId: 'call-owner', threadId: 'owner-thread', catId: 'owner-cat', state: callState });
    throw new Error('Unexpected owner path ' + path);
  });
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  useVoiceSessionStore.setState({ session: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const ready = async (threadId = 'consumer') => {
  const hook = renderHook(() =>
    useVoiceBindings(
      threadId,
      () => 'codex',
      workspace,
      {},
      () => true,
    ),
  );
  await waitFor(() =>
    expect(projectOwner('voice', hook.result.current, {}, threadId, undefined).cafeWsVoice.load).toBe(''),
  );
  return hook;
};
it('reads the capture service by its real id and shares the settings service snapshot', async () => {
  sharing = false;
  status = { running: false };
  const hook = await ready();
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.capture.canStart).toBe(true);
  expect(
    projectOwner('voice', hook.result.current, {}).voice.svc.find((s: { key: string }) => s.key === 'audio-capture')
      ?.running,
  ).toBe(true);
  expect(
    projectOwner('voice', hook.result.current, {}).voice.svc.find((s: { key: string }) => s.key === 'audio-capture')
      ?.state,
  ).toBe('running');
  services[0] = svc('audio-capture', ['meeting-copilot'], 'unhealthy');
  services[0].enabled = false;
  await act(() => hook.result.current.action('refresh', { k: 'voice' }));
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.service?.state).toBe('stopped');
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.capture.canStart).toBe(false);
  expect(
    projectOwner('voice', hook.result.current, {}).voice.svc.find((s: { key: string }) => s.key === 'audio-capture')
      ?.running,
  ).toBe(false);
});
it('keeps normal voice status silent and never polls capture or connects events when capture is not installed', async () => {
  vi.useFakeTimers();
  services[0].installed = false;
  services[0].enabled = false;
  const hook = renderHook(() =>
    useVoiceBindings(
      'consumer',
      () => 'codex',
      workspace,
      {},
      () => true,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(90_000));
  expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p) === '/api/services')).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p).startsWith('/api/audio/'))).toHaveLength(0);
  expect(Events.instances).toHaveLength(0);
  expect(projectOwner('voice', hook.result.current, {}, 'consumer', undefined).composerVoice).toMatchObject({
    service: null,
    state: '',
  });
  expect(projectOwner('voice', hook.result.current, {}, 'consumer', undefined).cafeWsVoice).toMatchObject({
    load: '',
    service: { state: 'not_configured' },
    capture: { canStart: false },
  });
});
it('paces failed capture reads at the ten-second status interval without creating a reconnecting event stream or logging errors', async () => {
  vi.useFakeTimers();
  const owner = vi.mocked(apiFetch).getMockImplementation()!,
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(apiFetch).mockImplementation((raw, init, options) =>
    String(raw) === '/api/audio/status'
      ? Promise.resolve(reply({ error: 'audio_unavailable' }, 502))
      : owner(raw, init, options),
  );
  const hook = renderHook(() =>
    useVoiceBindings(
      'consumer',
      () => 'codex',
      workspace,
      {},
      () => true,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(0));
  const reads = () => vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p) === '/api/audio/status').length;
  expect(reads()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(9_999));
  expect(reads()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(reads()).toBe(2);
  expect(projectOwner('voice', hook.result.current, {}, 'consumer', undefined).cafeWsVoice.load).toBe('error');
  expect(Events.instances).toHaveLength(0);
  expect(logged).not.toHaveBeenCalled();
});
it('closes an unavailable event stream and waits for the ten-second status read before reconnecting', async () => {
  vi.useFakeTimers();
  status = { running: false };
  const hook = renderHook(() =>
    useVoiceBindings(
      'consumer',
      () => 'codex',
      workspace,
      {},
      () => true,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(Events.instances).toHaveLength(1);
  const first = Events.current;
  await act(() => first.onerror!());
  expect(first.close).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(9_999));
  expect(Events.instances).toHaveLength(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(Events.instances).toHaveLength(2);
  expect(projectOwner('voice', hook.result.current, {}, 'consumer', undefined).composerVoice.state).toBe('');
});
it('does not pause or switch the producer when sharing cannot be revoked', async () => {
  revokeFails = true;
  const hook = await ready();
  await act(async () => {
    await expect(hook.result.current.action('voiceCaptureSource', { v: 'mic:2' })).rejects.toThrow('revoke_failed');
  });
  expect(writes.map((w) => w.path)).toEqual(['/api/concierge/meeting-share']);
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.capture.share?.sharing).toBe(true);
  expect(status.running).toBe(true);
});
it('revokes with the original intent and retains stop receipts under the producer thread', async () => {
  const hook = await ready('producer');
  await act(() => hook.result.current.action('meetingShare', { op: 'start' }));
  expect(writes[0].body).toEqual(intent);
  await act(() => hook.result.current.action('wsRec', { op: 'stop' }));
  expect(writes.slice(-2).map((w) => [w.method, w.path])).toEqual([
    ['DELETE', '/api/concierge/meeting-share'],
    ['POST', '/api/audio/stop'],
  ]);
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.items[0].source).toContain('worktreeId=wt');
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.capture.open).toEqual({
    v: 'meeting.md',
    w: 'wt',
  });
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.transcriptSource.threadId).toBe('producer');
});
it('never attributes another producer’s recording to the selected chat', async () => {
  const hook = await ready('consumer');
  await act(() => hook.result.current.action('wsRec', { op: 'stop' }));
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.items).toEqual([]);
  expect(projectOwner('voice', hook.result.current, {}).cafeWsVoice.transcript).toBe('');
});
it('starts from an admitted AudioInputRequest and corrects speaker identity without rewriting text', async () => {
  sharing = false;
  status = { running: false };
  const hook = await ready();
  await act(() => hook.result.current.action('wsRec', { op: 'start' }));
  expect(writes[0].body).toEqual({
    thread_id: 'consumer',
    inputs: [{ id: 'mic-2', source: 'mic', device: 2, label: 'Microphone' }],
  });
  await act(() => hook.result.current.action('transcriptCorrect', { lineId: '4' }));
  expect(writes[1].body).toEqual({ chunk_num: 4, speaker_id: 'speaker-1', speaker_label: 'Speaker 1' });
});
it('uses the backend call/thread identity for text and waits for owner teardown acknowledgement', async () => {
  const hook = await ready();
  hook.result.current.state.allowHomeReads = true;
  await act(() => hook.result.current.action('liveCall', { op: 'prepare' }));
  expect(writes[0].body).toEqual({ allowHomeReads: true });
  await act(() => hook.result.current.action('liveCallText', { v: 'inspect this change' }));
  expect(writes.at(-1)).toMatchObject({
    path: '/api/concierge/live/call-owner/text',
    body: { text: 'inspect this change' },
  });
  expect(writes.at(-1)?.body.clientMessageId).toMatch(/^[a-f0-9-]{36}$/);
  await act(() => hook.result.current.action('liveCall', { op: 'stop' }));
  expect(projectOwner('voice', hook.result.current, {}).composerVoice.call).toBeNull();
});
it('opens the microphone only after the prepared owner is ready and starts with its actual RTC offer', async () => {
  const stop = vi.fn(),
    getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] })),
    remoteDescription = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      iceGatheringState = 'complete';
      localDescription = { sdp: 'browser-offer' };
      addTrack() {}
      async createOffer() {
        return { type: 'offer', sdp: 'browser-offer' };
      }
      async setLocalDescription() {}
      async setRemoteDescription(value: unknown) {
        remoteDescription(value);
      }
      close() {}
    },
  );
  const hook = await ready();
  expect(getUserMedia).not.toHaveBeenCalled();
  callState = 'ready';
  await act(() => hook.result.current.action('liveCall', { op: 'prepare' }));
  await waitFor(() => expect(remoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'native-answer' }));
  expect(writes.find((w) => w.path.endsWith('/start') && w.path.includes('/live/'))).toMatchObject({
    path: '/api/concierge/live/call-owner/start',
    body: { offer: 'browser-offer' },
  });
  await act(() => hook.result.current.action('liveCall', { op: 'stop' }));
  expect(stop).toHaveBeenCalledOnce();
});
it('keeps the explicitly chosen screen identity until the owner acknowledges closing it', async () => {
  const track = { label: 'Selected application', stop: vi.fn(), onended: null },
    stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getDisplayMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const hook = await ready();
  callState = 'talking';
  await act(() => hook.result.current.action('liveCall', { op: 'prepare' }));
  expect(getDisplayMedia).not.toHaveBeenCalled();
  await act(() => hook.result.current.action('liveShare', { op: 'select' }));
  const grant = writes.find((w) => w.body.kind === 'open');
  expect(grant).toMatchObject({
    path: '/api/concierge/live/call-owner/screen',
    body: { kind: 'open', label: track.label },
  });
  expect(projectOwner('voice', hook.result.current, {}).composerVoice.share?.sourceRef).toBe(grant?.body.selectionId);
  await act(() => hook.result.current.action('liveShare', { op: 'stop' }));
  expect(writes.at(-1)?.body).toEqual({ kind: 'close' });
  expect(track.stop).toHaveBeenCalledOnce();
  expect(projectOwner('voice', hook.result.current, {}).composerVoice.share).toBeNull();
});

it('sets meeting advisory mode and starts DND through the existing capture owner, then pushes its actual status', async () => {
  const hook = await ready();
  await act(() => hook.result.current.action('meetingAdvisoryMode', { v: 'active' }));
  expect(projectOwner('voice', hook.result.current).cafeWsVoice.advisoryMode).toBe('active');
  await act(() => hook.result.current.action('meetingDnd', {}));
  expect(writes).toEqual([
    { path: '/api/audio/advisory-mode', method: 'POST', body: { mode: 'active' } },
    { path: '/api/audio/advisory-dnd', method: 'POST', body: {} },
  ]);
});

it('reads an install preview only on request and writes exact service ids, port and model before pushing actual lifecycle receipts', async () => {
  const owner = vi.mocked(apiFetch).getMockImplementation()!;
  const preview = {
    profile: {
      os: 'linux',
      arch: 'x64',
      gpu: 'none',
      ramGb: 31,
      diskFreeGb: 230,
      pythonArch: 'native',
      pythonVersion: '3.12.5',
    },
    recommendation: { models: [{ name: 'owner/model', description: 'Owner choice' }] },
    suggestedPort: 9444,
  };
  let fail = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init, options) => {
    if (path === '/api/services/mlx-tts/install-preview') return reply(preview);
    if (init?.method === 'POST' && String(path).startsWith('/api/services/'))
      return fail ? reply({ ok: false, error: 'service_script_failed' }) : reply({ ok: true });
    return owner(path, init, options);
  });
  const hook = await ready();
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith('/install-preview'))).toHaveLength(0);
  await act(() => hook.result.current.action('voiceInstallRead', { id: 'mlx-tts' }));
  expect(hook.result.current.data.installPreviews['mlx-tts']).toEqual(preview);
  const count = vi.mocked(apiFetch).mock.calls.length;
  for (let i = 0; i < 20; i++) projectOwner('voice', hook.result.current);
  expect(apiFetch).toHaveBeenCalledTimes(count);
  await act(() =>
    hook.result.current.action('voiceService', { id: 'mlx-tts', op: 'install', port: '9555', model: 'owner/model' }),
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/services/mlx-tts/install',
    expect.objectContaining({ method: 'POST', body: '{"port":9555,"model":"owner/model"}' }),
    { mutationTimeoutMs: 600000 },
  );
  await act(() =>
    hook.result.current.action('voiceService', {
      id: 'mlx-tts',
      op: 'reconfigure',
      port: '9666',
      model: 'owner/other',
    }),
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/services/mlx-tts/reconfigure',
    expect.objectContaining({ method: 'POST', body: '{"port":9666,"model":"owner/other"}' }),
    { mutationTimeoutMs: 600000 },
  );
  await act(() => hook.result.current.action('voiceService', { id: 'mlx-tts', op: 'uninstall' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/services/mlx-tts/uninstall',
    expect.objectContaining({ method: 'POST', body: '{}' }),
    { mutationTimeoutMs: 300000 },
  );
  fail = true;
  await expect(
    act(() => hook.result.current.action('voiceService', { id: 'mlx-tts', op: 'reconfigure', port: '9777' })),
  ).rejects.toThrow('service_script_failed');
  expect(vi.mocked(apiFetch).mock.calls.at(-1)![0]).toBe('/api/services');
});

it('resets the existing voice settings owner and restores the exact preferences for undo without any lifecycle writes', async () => {
  const owner = useVoiceSettingsStore.getState();
  owner.resetAll();
  owner.setLanguage('en');
  owner.setCustomPrompt('Owner prompt');
  owner.addTerm('heard', 'intended');
  const before = structuredClone(useVoiceSettingsStore.getState().settings);
  const hook = await ready();
  try {
    await act(() => hook.result.current.action('voiceSettingsReset', {}));
    expect(hook.result.current.data.settings).toEqual({ customTerms: [], customPrompt: null, language: 'zh' });
    await act(() => hook.result.current.action('voiceSettingsRestore', { value: JSON.stringify(before) }));
    expect(hook.result.current.data.settings).toEqual(before);
    expect(JSON.parse(localStorage.getItem('cat-cafe-voice-settings')!)).toEqual(before);
    expect(writes).toEqual([]);
  } finally {
    await act(() => useVoiceSettingsStore.getState().resetAll());
  }
});
