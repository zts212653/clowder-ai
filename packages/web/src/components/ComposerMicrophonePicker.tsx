'use client';

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { microphoneAccessIssue } from '@/hooks/microphone-errors';
import { useVoiceSettingsStore } from '@/stores/voiceSettingsStore';
import { AppTooltip } from './AppTooltip';
import { ComposerPopover } from './ComposerPopover';
import { MicIcon } from './icons/MicIcon';
import { microphoneCopy } from './microphone.shell-copy';
import { useShellCopy } from './shell/shell-copy';

type Listing = { devices: MediaDeviceInfo[]; hidden: boolean; canRequestAccess: boolean };
type ListError = 'permission-denied' | 'device-unavailable' | 'unsupported' | 'list-unavailable';
type ListState = Listing | ListError | null;

const optionClass =
  'shell-focusable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-cafe-secondary hover:bg-cafe-surface-sunken';

async function discoverMicrophones(requestAccess: boolean): Promise<ListState> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices || (requestAccess && !media.getUserMedia)) return 'unsupported';
  let stream: MediaStream | undefined;
  try {
    if (requestAccess) stream = await media.getUserMedia({ audio: true });
    const inputs = (await media.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const devices = inputs.filter((device) => device.deviceId && device.deviceId !== 'default');
    const hidden = inputs.some((device) => !device.deviceId || !device.label.trim());
    return { devices, hidden, canRequestAccess: !requestAccess && !!media.getUserMedia && (hidden || !devices.length) };
  } catch (error) {
    return microphoneAccessIssue(error) ?? 'list-unavailable';
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}

function MicrophoneOptions({
  anchor,
  onClose,
  presentation,
}: {
  anchor: RefObject<HTMLButtonElement>;
  onClose: () => void;
  presentation: 'classic' | 'v2';
}) {
  const t = useShellCopy(microphoneCopy);
  const selected = useVoiceSettingsStore((s) => s.settings.microphoneDeviceId);
  const select = useVoiceSettingsStore((s) => s.setMicrophoneDeviceId);
  const [list, setList] = useState<ListState>(null);
  const revision = useRef(0);
  const readDevices = useCallback(async (requestAccess: boolean) => {
    const current = ++revision.current;
    setList(null);
    const state = await discoverMicrophones(requestAccess);
    if (revision.current === current) setList(state);
  }, []);
  useEffect(() => {
    void readDevices(false);
    return () => {
      revision.current++;
    };
  }, [readDevices]);

  function choose(deviceId: string | null) {
    select(deviceId);
    onClose();
    anchor.current?.focus();
  }

  const errors = {
    'permission-denied': t.permissionDenied,
    'device-unavailable': t.unavailable,
    unsupported: t.unsupported,
    'list-unavailable': t.listUnavailable,
  };
  const listing = typeof list === 'object' ? list : null;
  const options = [
    { id: null, label: t.browserDefault },
    ...(listing?.devices.map((device, index) => ({
      id: device.deviceId,
      label: device.label.trim() || `${t.genericInput} ${index + 1}`,
    })) ?? []),
  ];
  return (
    <ComposerPopover
      anchor={anchor}
      label={t.choose}
      onClose={onClose}
      preferredWidth={270}
      presentation={presentation}
    >
      <div className="p-1">
        {options.map(({ id, label }) => (
          <button
            key={id ?? ''}
            type="button"
            aria-pressed={id === selected}
            className={optionClass}
            onClick={() => choose(id)}
          >
            <span className="w-4 shrink-0 text-cafe-accent" aria-hidden="true">
              {id === selected ? '✓' : ''}
            </span>
            <span className="min-w-0 break-words">{label}</span>
          </button>
        ))}
        <div className="px-2 text-xs leading-5 text-cafe-muted" aria-live="polite">
          {!list && <p>{t.readDevices}</p>}
          {typeof list === 'string' && <p>{errors[list]}</p>}
          {listing?.hidden && <p>{t.unnamedDevices}</p>}
          {listing && !listing.hidden && listing.devices.length === 0 && <p>{t.noDevices}</p>}
          {selected &&
            listing &&
            !listing.hidden &&
            !listing.devices.some((device) => device.deviceId === selected) && <p>{t.savedUnavailable}</p>}
        </div>
        {listing?.canRequestAccess && (
          <button type="button" className={optionClass} onClick={() => void readDevices(true)}>
            {t.permissionAction}
          </button>
        )}
      </div>
    </ComposerPopover>
  );
}

export function ComposerMicrophonePicker({
  disabled,
  presentation = 'v2',
  standalone = false,
}: {
  disabled?: boolean;
  presentation?: 'classic' | 'v2';
  standalone?: boolean;
}) {
  const t = useShellCopy(microphoneCopy);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <>
      <AppTooltip label={t.choose} side="top" disabled={open}>
        <button
          ref={anchor}
          type="button"
          aria-label={t.choose}
          aria-haspopup="dialog"
          aria-expanded={open && !disabled}
          disabled={disabled}
          onClick={() => setOpen(!open)}
          className={`shell-focusable flex h-8 shrink-0 items-center justify-center rounded-md text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-accent disabled:opacity-40 ${standalone ? 'w-10 gap-0.5' : 'w-6'}`}
        >
          {standalone && <MicIcon className="h-4 w-4" />}
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </AppTooltip>
      {open && !disabled && (
        <MicrophoneOptions anchor={anchor} onClose={() => setOpen(false)} presentation={presentation} />
      )}
    </>
  );
}
