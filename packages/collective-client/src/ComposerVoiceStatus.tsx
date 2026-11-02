import { useCollectiveLanguage } from './collective-copy.js';
import type { useComposerVoice } from './use-composer-voice.js';

export function ComposerVoiceStatus({ voice }: { voice: ReturnType<typeof useComposerVoice> }) {
  const en = useCollectiveLanguage() === 'en';
  const draft = voice.draft;
  if (!draft && !voice.notice) return null;
  const duration = `${Math.floor(voice.duration / 60)}:${String(voice.duration % 60).padStart(2, '0')}`;
  return (
    <div className="composer-voice-status" data-voice-status={draft?.state}>
      {draft && (
        <>
          <span role="status">
            {draft.state === 'recording'
              ? en
                ? `Listening… ${duration}`
                : `正在听… ${duration}`
              : draft.state === 'transcribing'
                ? en
                  ? 'Transcribing…'
                  : '正在转成文字…'
                : draft.state === 'failed'
                  ? en
                    ? 'Could not transcribe · Recording kept'
                    : '没转成文字 · 原录音已保留'
                  : draft.applied
                    ? en
                      ? 'Added to your draft · Recording is private'
                      : '文字已放进草稿 · 录音仅自己可见'
                    : en
                      ? 'Transcription kept · Make room to insert it'
                      : '转写已保留 · 请留出位置再放进草稿'}
          </span>
          {draft.state === 'failed' && (
            <button type="button" disabled={!voice.available} onClick={() => void voice.retry()}>
              {en ? 'Try again' : '再试一次'}
            </button>
          )}
          {draft.state === 'ready' && !draft.applied && (
            <>
              <p className="composer-voice-transcript">{draft.transcript}</p>
              <button type="button" onClick={voice.insert}>
                {en ? 'Insert into draft' : '放进草稿'}
              </button>
            </>
          )}
          <button type="button" onClick={() => void voice.cancel()}>
            {draft.applied ? (en ? 'Remove recording' : '移除录音') : en ? 'Cancel' : '取消'}
          </button>
          {voice.audioUrl && (
            <audio
              src={voice.audioUrl}
              controls
              preload="metadata"
              aria-label={en ? 'Private recording' : '私人录音'}
            />
          )}
        </>
      )}
      {voice.notice && <p role="status">{voice.notice}</p>}
    </div>
  );
}
