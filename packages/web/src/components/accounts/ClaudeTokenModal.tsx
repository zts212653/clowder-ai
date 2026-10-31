'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accountRequest } from '../codex-accounts/account-request';
import type { ProfileItem } from '../hub-accounts.types';
import { formInputClass } from '../mcp-form-helpers';
import { useShellLanguage } from '../shell/shell-language';

export function ClaudeTokenModal({
  account,
  onClose,
  onSaved,
}: {
  account?: ProfileItem;
  onClose: () => void;
  onSaved: (profile: ProfileItem) => void;
}) {
  const en = useShellLanguage() === 'en';
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const [name, setName] = useState(account?.displayName ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ profile: ProfileItem }>(
        account ? `/api/accounts/${encodeURIComponent(account.id)}` : '/api/accounts',
        {
          displayName: name.trim(),
          ...(token.trim() ? { claudeToken: token.trim() } : {}),
          ...(!account ? { authType: 'oauth', clientId: 'anthropic' } : {}),
        },
        account ? 'PATCH' : 'POST',
      );
      setToken('');
      onSaved(result.profile);
      onClose();
    } catch {
      // Never echo submitted credentials or a server diagnostic carrying request content.
      setError(en ? 'Account could not be saved. Check the inputs and retry.' : '账号未能保存，请核对输入后重试。');
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-full max-w-md max-h-[calc(100vh-32px)] overflow-y-auto rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5 text-cafe-primary shadow-2xl backdrop:bg-[var(--console-overlay-medium)]"
      aria-modal="true"
      aria-label={en ? 'Claude token account' : 'Claude 长效 token 账号'}
    >
      <h3 className="mb-3 font-semibold">{en ? 'Claude · Long-lived token' : 'Claude · 长效 token'}</h3>
      <p className="mb-3 text-sm text-cafe-muted">
        {en
          ? 'Run claude setup-token in your own terminal and complete the official login. Paste the resulting token here, never in chat.'
          : '在自己的终端执行 claude setup-token，亲自完成官方登录。将得到的 token 填在这里，不要发到聊天。'}
      </p>
      <p className="mb-3 text-sm text-cafe-muted">
        {en
          ? 'For model requests and local MCP. Remote Control and claude.ai connectors are unavailable with this token.'
          : '用于模型调用和本地 MCP。此 token 不支持 Remote Control 或 claude.ai connectors。'}
      </p>
      <p className="mb-3 text-sm text-cafe-muted">
        {en
          ? 'Saving does not switch members. Account identity, expiry and quota cannot be verified from this token.'
          : '保存后不会自动换号。此 token 的账号身份、到期时间和额度尚不能验证。'}
      </p>
      <a
        href="https://code.claude.com/docs/en/authentication#generate-a-long-lived-token"
        target="_blank"
        rel="noreferrer"
      >
        {en ? 'Official instructions ↗' : '官方说明 ↗'}
      </a>
      <label className="mt-3 block text-sm">
        {en ? 'Account note' : '账号备注'}
        <input
          className={formInputClass}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
        />
      </label>
      <label className="mt-3 block text-sm">
        {en ? 'Long-lived token' : '长效 token'}
        <input
          className={formInputClass}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {account && (
        <p className="mt-2 text-sm text-cafe-muted">
          {en ? 'Leave token empty to keep the saved credential.' : 'token 留空则保留已保存的凭据。'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="account-primary"
        type="button"
        disabled={busy || !name.trim() || (!account && !token.trim())}
        onClick={() => void save()}
      >
        {account ? (en ? 'Save changes' : '保存更改') : en ? 'Save token' : '保存 token'}
      </button>
      <button className="account-button" type="button" disabled={busy} onClick={onClose}>
        {en ? 'Cancel' : '取消'}
      </button>
    </dialog>,
    document.body,
  );
}
