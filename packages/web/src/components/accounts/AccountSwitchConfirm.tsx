'use client';
import { useEffect, useState } from 'react';
import { accountRequest } from '../codex-accounts/account-request';
import type { AccountSelection, ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { accountDisplayName } from './account-directory-view';
import { accountMessage } from './account-message';
import { accountsCopy } from './accounts.shell-copy';

interface Preview {
  previewToken: string;
  accountRef: string;
  targets: Array<{ catId: string; name: string; previousAccountRef: string }>;
  exceptions: Array<{ catId: string; name: string; previousAccountRef: string; previousAccountName?: string }>;
  selection?: AccountSelection;
}
export function AccountSwitchConfirm({
  account,
  onClose,
  onChanged,
}: {
  account: ProfileItem;
  onClose: () => void;
  onChanged: (selection: AccountSelection) => void;
}) {
  const t = useShellCopy(accountsCopy);
  const language = useShellLanguage();
  const tool = account.clientId === 'anthropic' ? 'claude' : 'codex';
  const [includeOverrides, setIncludeOverrides] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setPreview(undefined);
    setError('');
    void accountRequest<Preview>(`/api/accounts/${encodeURIComponent(account.id)}/${tool}/binding/preview`, {
      scope: 'local',
      includeOverrides,
    })
      .then((result) => {
        if (current) setPreview(result);
      })
      .catch((e) => {
        if (current) setError(e instanceof Error ? e.message : '无法预览换号');
      });
    return () => {
      current = false;
    };
  }, [account.id, includeOverrides, tool]);
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<Preview>(
        `/api/accounts/${encodeURIComponent(account.id)}/${tool}/binding/commit`,
        { scope: 'local', includeOverrides, previewToken: preview.previewToken },
      );
      if (!result.selection) throw new Error('换号结果读不到，请刷新核对');
      onChanged(result.selection);
      window.dispatchEvent(new CustomEvent('accounts-changed'));
      window.dispatchEvent(new CustomEvent('cat-config-changed'));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '换号失败');
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-switch-confirm" aria-label={t.switchTitle}>
      <h3>{t.switchName(accountDisplayName(account, t))}</h3>
      <p>{t.switchTiming}</p>
      <p>{t.switchNative}</p>
      {account.claude && <p>{t.tokenUnknown}</p>}
      {error && <p role="alert">{accountMessage(error, language)}</p>}
      {preview ? (
        <>
          <p>{t.switchCount(preview.targets.length)}</p>
          <p>{preview.targets.map((m) => m.name).join(language === 'zh' ? '、' : ', ') || t.noTargets}</p>
          {preview.exceptions.length > 0 && (
            <div>
              <p>
                {t.exceptionCount(
                  preview.exceptions.length,
                  preview.exceptions
                    .map((m) => `${m.name}（${m.previousAccountName ?? m.previousAccountRef}）`)
                    .join(language === 'zh' ? '、' : ', '),
                )}
              </p>
              <p>{t.keepExceptions}</p>
            </div>
          )}
          {(preview.exceptions.length > 0 || includeOverrides) && (
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={includeOverrides}
                  disabled={busy}
                  onChange={(e) => setIncludeOverrides(e.target.checked)}
                />
                {t.includeOverrides}
              </label>
              {includeOverrides && <p>{t.includedHint}</p>}
            </div>
          )}
          <button type="button" className="account-primary" disabled={busy} onClick={() => void commit()}>
            {t.confirmSwitch}
          </button>
        </>
      ) : (
        !error && <p>{t.readingTargets}</p>
      )}
      <button type="button" className="account-button" disabled={busy} onClick={onClose}>
        {t.cancel}
      </button>
    </section>
  );
}
