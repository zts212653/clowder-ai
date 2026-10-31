'use client';

import { useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { AudioInputRequest, AudioSources } from './audio-transcript-contract';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

/**
 * §1.14 语音 2 — the v2 prepare state: 应用声音 and 麦克风 pickers, 开始采集, and the honest hint that one of the
 * two inputs is enough. Source names are service data and render as-is.
 */
export function AudioInputPickerV2({
  sources,
  onStart,
  disabled = false,
}: {
  sources: AudioSources;
  onStart: (inputs: AudioInputRequest[]) => void;
  disabled?: boolean;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const [appName, setAppName] = useState('');
  const [micIndex, setMicIndex] = useState('');
  const selected = Boolean(appName || micIndex);

  const start = () => {
    const inputs: AudioInputRequest[] = [];
    if (appName) {
      const app = sources.apps.find((item) => item.id === appName);
      inputs.push({ id: 'app', source: 'app', app_name: appName, label: app?.name ?? appName });
    }
    if (micIndex) {
      const device = Number(micIndex);
      const mic = sources.mics.find((item) => item.index === device);
      inputs.push({ id: 'mic', source: 'mic', device, label: mic?.name ?? 'Microphone' });
    }
    if (inputs.length) onStart(inputs);
  };

  const selectClass =
    'w-full appearance-none rounded-lg border border-cafe-border bg-cafe-surface-primary px-2.5 py-1.5 text-xs text-cafe-text-primary';

  return (
    <div className="space-y-2" data-testid="audio-input-picker-v2">
      <label className="block text-micro text-cafe-text-secondary">
        {t.capture.appAudio}
        <select
          aria-label={t.capture.appAudio}
          value={appName}
          onChange={(event) => setAppName(event.target.value)}
          className={`mt-1 ${selectClass}`}
        >
          <option value="">{t.capture.none}</option>
          {sources.apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-micro text-cafe-text-secondary">
        {t.capture.microphone}
        <select
          aria-label={t.capture.microphone}
          value={micIndex}
          onChange={(event) => setMicIndex(event.target.value)}
          className={`mt-1 ${selectClass}`}
        >
          <option value="">{t.capture.none}</option>
          {sources.mics.map((mic) => (
            <option key={mic.index} value={mic.index}>
              {mic.default ? t.capture.defaultMic(mic.name) : mic.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!selected || disabled}
          onClick={start}
          className="rounded-lg bg-cafe-text-primary px-3 py-1.5 text-xs font-medium text-cafe-surface-primary transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="start-capture"
        >
          {t.capture.startCapture}
        </button>
        <span className="text-micro text-cafe-text-muted">{t.capture.pickHint}</span>
      </div>
    </div>
  );
}
