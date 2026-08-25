import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsCodeField } from './primitives/SettingsCodeField';
import { SettingsSecondaryButton } from './primitives/SettingsSecondaryButton';
import { SettingsText } from './primitives/SettingsText';

export function OfficialPluginHistoryImport({
  instanceId,
  expectedRevision,
}: {
  readonly instanceId: string;
  readonly expectedRevision: number;
}) {
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'muted' | 'red'; text: string } | null>(null);

  const submit = async () => {
    const normalizedReference = reference.trim();
    if (!normalizedReference) {
      setMessage({ tone: 'red', text: '请粘贴飞书妙记链接或 token。' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/plugins/official/${instanceId}/history-import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision, reference: normalizedReference }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        disposition?: 'accepted' | 'duplicate';
        error?: string;
      };
      if (!response.ok) {
        setMessage({ tone: 'red', text: body.error ?? `历史妙记导入失败 (${response.status})` });
        return;
      }
      setReference('');
      setMessage({
        tone: 'muted',
        text: body.disposition === 'duplicate' ? '这篇历史妙记已经在待处理列表中。' : '历史妙记已进入待处理列表。',
      });
    } catch {
      setMessage({ tone: 'red', text: '历史妙记导入网络错误。' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-[var(--console-border-soft)] pt-3">
      <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
        导入历史妙记
      </SettingsText>
      <SettingsText as="p" tone="muted" className="mt-1">
        粘贴飞书妙记链接或 token；会沿用当前飞书授权并进入同一待处理列表。
      </SettingsText>
      <div className="mt-2 flex items-center gap-2">
        <SettingsCodeField
          type="text"
          aria-label="飞书妙记链接或 token"
          placeholder="https://…/minutes/… 或 token"
          value={reference}
          disabled={busy}
          onChange={(event) => setReference(event.target.value)}
        />
        <SettingsSecondaryButton disabled={busy} onClick={() => void submit()}>
          {busy ? '导入中…' : '导入历史妙记'}
        </SettingsSecondaryButton>
      </div>
      {message && (
        <SettingsText as="p" tone={message.tone} className="mt-1">
          {message.text}
        </SettingsText>
      )}
    </div>
  );
}
