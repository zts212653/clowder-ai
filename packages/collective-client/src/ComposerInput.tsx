import {
  ComposerAttachmentPreview,
  ComposerControl,
  ComposerFrame,
  MessageMediaViewer,
  VoiceInputButton,
} from '@cat-cafe/ui';
import { type RefObject, type TextareaHTMLAttributes, useState } from 'react';
import { CollectiveIcon } from './CollectiveIcon.js';
import { ComposerVoiceStatus } from './ComposerVoiceStatus.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import type { useComposerAttachments } from './use-composer-attachments.js';
import type { useComposerVoice } from './use-composer-voice.js';

/** Shared expression surface; recipient/work authority and durable draft transitions remain in Composer. */
export function ComposerInput({
  files,
  input,
  inputRef,
  fileRef,
  expanded,
  onExpand,
  disabled,
  controls,
  voice,
}: {
  readonly files: ReturnType<typeof useComposerAttachments>;
  readonly input: TextareaHTMLAttributes<HTMLTextAreaElement>;
  readonly inputRef: RefObject<HTMLTextAreaElement>;
  readonly fileRef: RefObject<HTMLInputElement>;
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly disabled: boolean;
  readonly controls?: React.ReactNode;
  readonly voice?: ReturnType<typeof useComposerVoice>;
}) {
  const language = useCollectiveLanguage(),
    t = useCollectiveText();
  const [selected, setSelected] = useState<string>();
  const item = files.items.find((value) => value.id === selected);
  return (
    <>
      {voice && <ComposerVoiceStatus voice={voice} />}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        aria-label={language === 'en' ? 'Add files' : '添加文件'}
        onChange={(event) => {
          void files.add([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = '';
        }}
      />
      <ComposerFrame className="composer-box">
        <ComposerAttachmentPreview
          items={files.items}
          onRemove={files.remove}
          onRetry={files.retry}
          onOpen={setSelected}
          labels={{
            remove: (name) => (language === 'en' ? `Remove ${name}` : `移除 ${name}`),
            retry: language === 'en' ? 'Retry' : '重试',
            uploading: language === 'en' ? 'Uploading…' : '正在上传…',
          }}
        />
        <textarea
          {...input}
          ref={inputRef}
          maxLength={32000}
          rows={1}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.items]
              .filter((value) => value.kind === 'file')
              .map((value) => value.getAsFile())
              .filter((file): file is File => !!file);
            if (pasted.length) {
              event.preventDefault();
              void files.add(pasted);
            } else input.onPaste?.(event);
          }}
        />
        <ComposerControl
          type="button"
          className="composer-expand"
          aria-label={t('更多输入选项')}
          aria-expanded={expanded}
          onClick={onExpand}
        >
          +
        </ComposerControl>
        {controls}
        {voice && (
          <VoiceInputButton
            language={language}
            available={voice.available}
            disabled={!!voice.draft || !voice.ready}
            state={
              voice.draft?.state === 'recording'
                ? 'recording'
                : voice.draft?.state === 'transcribing'
                  ? 'transcribing'
                  : 'idle'
            }
            onStart={() => void voice.start()}
            onStop={voice.stop}
          />
        )}
        <button type="submit" className="composer-send" aria-label={t('发送')} disabled={disabled}>
          <CollectiveIcon kind="send" />
        </button>
      </ComposerFrame>
      {item?.url && (
        <MessageMediaViewer
          item={{ id: item.id, url: item.url, title: item.name, mediaType: item.mediaType }}
          onClose={() => setSelected(undefined)}
          closeLabel={language === 'en' ? 'Close' : '关闭'}
        />
      )}
    </>
  );
}
