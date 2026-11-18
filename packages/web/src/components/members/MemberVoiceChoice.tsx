'use client';

import type { CatVoiceOption, VoiceConfig } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { HubCatEditorFormState } from '../hub-cat-editor.model';
import { SelectField } from '../hub-cat-editor-fields';
import { useMemberText } from './editor-presentation';

function voiceFields(voice: VoiceConfig): Partial<HubCatEditorFormState> {
  return {
    voiceVoice: voice.voice,
    voiceLangCode: voice.langCode,
    voiceSpeed: voice.speed == null ? '' : String(voice.speed),
    voiceRefAudio: voice.refAudio ?? '',
    voiceRefText: voice.refText ?? '',
    voiceInstruct: voice.instruct ?? '',
    voiceTemperature: voice.temperature == null ? '' : String(voice.temperature),
  };
}

export function MemberVoiceChoice({
  form,
  onChange,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: Partial<HubCatEditorFormState>) => void;
}) {
  const t = useMemberText();
  const [choices, setChoices] = useState<CatVoiceOption[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately reissues this same read after a failure.
  useEffect(() => {
    let active = true;
    setState('loading');
    apiFetch('/api/tts/voices')
      .then(async (response) => {
        if (!response.ok) throw new Error('Voice choices unavailable');
        const data: { voices?: CatVoiceOption[] } = await response.json();
        if (!Array.isArray(data.voices)) throw new Error('Invalid voice choices');
        if (active) {
          setChoices(data.voices);
          setState('ready');
        }
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const selected = choices.find((choice) =>
    Object.entries(voiceFields(choice.voiceConfig)).every(
      ([key, value]) => form[key as keyof HubCatEditorFormState] === value,
    ),
  );
  return (
    <div className="space-y-2">
      <SelectField
        label={t('选择声线')}
        ariaLabel="Voice choice"
        value={selected?.id ?? ''}
        disabled={state !== 'ready'}
        options={[
          { value: '', label: t(state === 'loading' ? '正在读取声线…' : '保留当前设置') },
          ...choices.map((choice) => ({
            value: choice.id,
            label: `${choice.familyName} · ${choice.label}${choice.referenceAvailability === 'unknown' ? ` · ${t('参考音频待读取端确认')}` : choice.available ? '' : ` · ${t('参考音频不可用')}`}`,
            disabled: !choice.available,
          })),
        ]}
        onChange={(id) => {
          const choice = choices.find((item) => item.id === id);
          if (choice?.available) {
            onChange(voiceFields(choice.voiceConfig));
          }
        }}
      />
      {state === 'error' && (
        <div role="alert" className="text-xs text-cafe-secondary">
          {t('声线列表暂时读不到')}{' '}
          <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>
            {t('重试')}
          </button>
        </div>
      )}
      {state === 'ready' && choices.length === 0 && (
        <p className="text-xs text-cafe-muted">{t('还没有可用的候选声线，可在下方填写。')}</p>
      )}
      {!form.voiceVoice && !form.voiceRefAudio && (
        <p className="text-xs text-cafe-secondary">{t('未设置本人声线，合成时会使用默认声音。')}</p>
      )}
    </div>
  );
}
