'use client';

import { useRef, useState } from 'react';
import type { HubCatEditorFormState } from './hub-cat-editor.model';
import { SelectField, TextField } from './hub-cat-editor-fields';

type FormPatch = Partial<HubCatEditorFormState>;

const VOICE_LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '未设置' },
  { value: 'z', label: '中文 (z)' },
  { value: 'zh', label: '中文 (zh)' },
  { value: 'en-us', label: 'English (en-us)' },
  { value: 'ja', label: '日本語 (ja)' },
];

function refAudioDisplayName(path: string): string {
  if (!path) return '';
  const segments = path.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1]!;
}

function RefAudioField({ value, onUpload }: { value: string; onUpload: (file: File) => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const filename = refAudioDisplayName(value);

  return (
    <div className="flex flex-col gap-1.5 text-[#5C4B42] sm:flex-row sm:items-center sm:gap-3">
      <span className="text-sm font-medium text-[#5C4B42] sm:w-[140px] sm:shrink-0">Ref Audio</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2 text-sm leading-5 text-[#2D2118]"
          title={value}
        >
          {filename ? filename : <span className="text-[#8A776B]">未设置</span>}
        </span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2 text-sm font-semibold text-[#5C4B42] transition hover:border-[#D49266]"
        >
          上传
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/wav,audio/mpeg,audio/mp3,audio/webm,audio/ogg,.wav,.mp3,.webm,.ogg"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void onUpload(file).finally(() => {
              if (fileRef.current) fileRef.current.value = '';
            });
          }}
        />
      </div>
    </div>
  );
}

export function VoiceConfigSection({
  form,
  onChange,
  onRefAudioUpload,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: FormPatch) => void;
  onRefAudioUpload: (file: File) => Promise<void>;
}) {
  const hasVoiceConfig = Boolean(
    form.voiceVoice ||
      form.voiceLangCode ||
      form.voiceSpeed ||
      form.voiceRefAudio ||
      form.voiceRefText ||
      form.voiceInstruct ||
      form.voiceTemperature,
  );
  const [expanded, setExpanded] = useState(hasVoiceConfig);
  const summary = hasVoiceConfig ? `${form.voiceLangCode ? form.voiceLangCode : '?'}` : '';

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-[#DCC9B8] bg-[#F7F3F0] px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left text-sm font-semibold text-[#8A776B]"
      >
        {expanded ? '▾' : '▸'} Voice Config{summary ? ` — ${summary}` : ''}
      </button>
      {!expanded && <p className="mt-0.5 text-xs leading-4 text-[#B59A88]">展开后可配置 TTS clone 参考音频和文本。</p>}
      {expanded && (
        <div className="space-y-2">
          <SelectField
            label="Lang Code"
            ariaLabel="Voice Lang Code"
            value={form.voiceLangCode}
            options={VOICE_LANG_OPTIONS}
            onChange={(value) => {
              const patch: FormPatch = { voiceLangCode: value };
              if (value && !form.voiceVoice) patch.voiceVoice = 'zm_yunjian';
              onChange(patch);
            }}
          />
          <TextField
            label="Voice"
            ariaLabel="Voice Name"
            value={form.voiceVoice}
            onChange={(value) => onChange({ voiceVoice: value })}
            placeholder="zm_yunjian"
          />
          <TextField
            label="Speed"
            ariaLabel="Voice Speed"
            value={form.voiceSpeed}
            onChange={(value) => onChange({ voiceSpeed: value })}
            placeholder="1.0"
          />
          <RefAudioField value={form.voiceRefAudio} onUpload={onRefAudioUpload} />
          <TextField
            label="Ref Text"
            ariaLabel="Reference Audio Text"
            value={form.voiceRefText}
            onChange={(value) => onChange({ voiceRefText: value })}
            placeholder="参考音频对应的文本"
          />
          <TextField
            label="Instruct"
            ariaLabel="Voice Style Instruction"
            value={form.voiceInstruct}
            onChange={(value) => onChange({ voiceInstruct: value })}
            placeholder="如：用一个调皮狡黠的少年语气说话"
          />
          <TextField
            label="Temperature"
            ariaLabel="Voice Temperature"
            value={form.voiceTemperature}
            onChange={(value) => onChange({ voiceTemperature: value })}
            placeholder="0.3"
          />
        </div>
      )}
    </div>
  );
}
