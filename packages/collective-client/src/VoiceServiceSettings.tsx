import { useEffect, useRef, useState } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';
import type { useDeviceVoiceService } from './use-device-voice-service.js';

export function VoiceServiceSettings({
  voice,
  onClose,
}: {
  voice: ReturnType<typeof useDeviceVoiceService>;
  onClose: () => void;
}) {
  const en = useCollectiveLanguage() === 'en';
  const [endpoint, setEndpoint] = useState(voice.savedEndpoint);
  const operation = useRef<AbortController>();
  useEffect(() => () => operation.current?.abort(), []);
  return (
    <section className="composer-voice-settings" aria-label={en ? 'Voice settings' : '语音设置'}>
      <strong>{en ? 'Voice input on this device' : '这台设备的语音输入'}</strong>
      <p>
        {en
          ? 'Connect an existing local transcription service. This only configures your account on this device.'
          : '连接这台设备上已有的转写服务。设置仅用于你在这台设备上的账号。'}
      </p>
      <label>
        {en ? 'Local service address' : '本机转写服务地址'}
        <input
          type="url"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="http://127.0.0.1:…"
        />
      </label>
      <button
        type="button"
        disabled={voice.checking || !endpoint.trim()}
        onClick={() => {
          operation.current?.abort();
          const controller = new AbortController();
          operation.current = controller;
          void voice.configure(endpoint, controller.signal).then((connected) => {
            if (connected) onClose();
          });
        }}
      >
        {voice.checking ? (en ? 'Checking…' : '正在检查…') : en ? 'Check and enable' : '检查并启用'}
      </button>
      {voice.savedEndpoint && (
        <button
          type="button"
          onClick={() => {
            voice.remove();
            setEndpoint('');
          }}
        >
          {en ? 'Disconnect' : '断开连接'}
        </button>
      )}
      <button type="button" onClick={onClose}>
        {en ? 'Close' : '关闭'}
      </button>
      {voice.error && <p role="status">{voice.error}</p>}
    </section>
  );
}
