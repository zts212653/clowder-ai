import { useState } from 'react';
import { ComposerStickers } from './ComposerStickers.js';
import type { CollectiveRecipient } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import type { useComposerAttachments } from './use-composer-attachments.js';
import type { useDeviceVoiceService } from './use-device-voice-service.js';
import { VoiceServiceSettings } from './VoiceServiceSettings.js';

export function ComposerTray({
  recipientKind,
  entrust,
  responseRequested,
  onMention,
  onEntrust,
  onResponseRequested,
  onFiles,
  files,
  channelId,
  voiceDevice,
}: {
  readonly recipientKind: CollectiveRecipient['kind'];
  readonly entrust: boolean;
  readonly responseRequested: boolean;
  readonly onMention: () => void;
  readonly onEntrust: (value: boolean) => void;
  readonly onResponseRequested: (value: boolean) => void;
  readonly onFiles?: () => void;
  readonly files?: ReturnType<typeof useComposerAttachments>;
  readonly channelId?: string;
  readonly voiceDevice?: ReturnType<typeof useDeviceVoiceService>;
}) {
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  const [stickers, setStickers] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState(false);
  return (
    <>
      <div className="composer-tray">
        {files && channelId && (
          <button type="button" onClick={() => setStickers(true)}>
            {language === 'en' ? 'Stickers' : '贴纸'}
          </button>
        )}
        {voiceDevice && (
          <button type="button" onClick={() => setVoiceSettings((value) => !value)}>
            {language === 'en' ? 'Voice settings' : '语音设置'}
          </button>
        )}
        {onFiles && (
          <button type="button" onClick={onFiles}>
            {language === 'en' ? 'Add files' : '添加文件'}
          </button>
        )}
        <button type="button" onClick={onMention}>
          @ {t('提到成员')}
        </button>
        {recipientKind === 'agent' && (
          <label>
            <input type="checkbox" checked={entrust} onChange={(event) => onEntrust(event.target.checked)} />
            {t('请求持续处理')}
          </label>
        )}
        {recipientKind === 'channel' && (
          <label>
            <input
              type="checkbox"
              checked={responseRequested}
              onChange={(event) => onResponseRequested(event.target.checked)}
            />
            {t('希望伙伴回应')}
          </label>
        )}
        {entrust && <small>{t('由猫的主人安排私人任务，结果回到这里。')}</small>}
        {responseRequested && <small>{t('只通知自愿值守回应请求的伙伴；普通消息仍会安静送达。')}</small>}
      </div>
      {stickers && files && channelId && (
        <ComposerStickers channelId={channelId} files={files} onClose={() => setStickers(false)} />
      )}
      {voiceSettings && voiceDevice && (
        <VoiceServiceSettings voice={voiceDevice} onClose={() => setVoiceSettings(false)} />
      )}
    </>
  );
}
