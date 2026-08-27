'use client';

import { useState } from 'react';
import type { AudioInputRequest, AudioSources } from './audio-transcript-contract';

export function AudioInputPicker({
  sources,
  onStart,
  disabled = false,
}: {
  sources: AudioSources;
  onStart: (inputs: AudioInputRequest[]) => void;
  disabled?: boolean;
}) {
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

  return (
    <div className="space-y-2">
      <label className="block text-micro text-cafe-text-secondary">
        App audio
        <select
          aria-label="App audio"
          value={appName}
          onChange={(event) => setAppName(event.target.value)}
          className="mt-1 w-full rounded border border-cafe-border bg-cafe-surface-primary px-2 py-1 text-xs text-cafe-text-primary"
        >
          <option value="">None</option>
          {sources.apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-micro text-cafe-text-secondary">
        Local microphone
        <select
          aria-label="Local microphone"
          value={micIndex}
          onChange={(event) => setMicIndex(event.target.value)}
          className="mt-1 w-full rounded border border-cafe-border bg-cafe-surface-primary px-2 py-1 text-xs text-cafe-text-primary"
        >
          <option value="">None</option>
          {sources.mics.map((mic) => (
            <option key={mic.index} value={mic.index}>
              {mic.name}
              {mic.default ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!selected || disabled}
        onClick={start}
        className="w-full rounded bg-[var(--semantic-success)] px-2 py-1 text-xs font-medium text-[var(--cafe-surface)] hover:bg-conn-green-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        Start {appName && micIndex ? 'App + mic' : 'capture'}
      </button>
    </div>
  );
}
