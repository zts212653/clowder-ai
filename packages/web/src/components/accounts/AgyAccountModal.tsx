'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { accountRequest } from '../codex-accounts/account-request';
import type { ProfileItem } from '../hub-accounts.types';
import { formInputClass } from '../mcp-form-helpers';
import { useShellLanguage } from '../shell/shell-language';

export function AgyAccountModal({
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
  const [saved, setSaved] = useState(account);
  const [name, setName] = useState(account?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ profile: ProfileItem }>(
        saved ? `/api/accounts/${encodeURIComponent(saved.id)}` : '/api/accounts',
        { displayName: name.trim(), ...(!saved ? { authType: 'oauth', clientId: 'google', agyOAuth: true } : {}) },
        saved ? 'PATCH' : 'POST',
      );
      setSaved(result.profile);
      onSaved(result.profile);
    } catch {
      setError(en ? 'Could not save the account.' : '账号未能保存，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!saved) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/accounts', undefined, { afterCurrentGet: true });
      if (!response.ok) throw new Error('accounts_unavailable');
      const result = (await response.json()) as { providers: ProfileItem[] };
      const next = result.providers.find((item) => item.id === saved.id);
      if (!next) throw new Error('missing_account');
      setSaved(next);
      onSaved(next);
    } catch {
      setError(en ? 'Could not read login status.' : '登录状态读不到，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const ready = saved?.agyLoginStatus === 'ready' || saved?.agyLoginStatus === 'refreshable';
  return createPortal(
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-full max-w-md max-h-[calc(100vh-32px)] overflow-y-auto rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5 text-cafe-primary shadow-2xl backdrop:bg-[var(--console-overlay-medium)]"
      aria-label="AGY · Google OAuth"
    >
      <h3 className="mb-3 font-semibold">AGY · Google OAuth</h3>
      <p className="mb-3 text-sm text-cafe-muted">
        {en
          ? 'Add an account note, then complete Google sign-in in your own terminal. Saving does not switch members.'
          : '先填写备注，再在自己的终端完成 Google 授权。保存不会自动给猫换号。'}
      </p>
      <label className="block text-sm">
        {en ? 'Account note' : '账号备注'}
        <input
          className={formInputClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          autoComplete="off"
        />
      </label>
      <button className="account-primary" type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
        {en ? 'Save account' : '保存账号'}
      </button>
      {saved && (
        <div className="mt-3 space-y-3 text-sm">
          <p>
            {en
              ? 'Run this command, follow the official Google authorization instructions, then return here.'
              : '在自己的终端运行这条命令，按官方提示完成 Google 授权后回到这里。'}
          </p>
          {saved.agyLoginCommand ? (
            <textarea
              aria-label={en ? 'Official login command' : '官方登录命令'}
              className={`${formInputClass} h-auto min-h-32 font-mono text-xs`}
              readOnly
              rows={5}
              value={saved.agyLoginCommand}
              onFocus={(event) => event.target.select()}
            />
          ) : (
            <p role="alert">{en ? 'Install the official agy CLI first.' : '请先安装官方 agy CLI。'}</p>
          )}
          <button className="account-button" type="button" disabled={busy} onClick={() => void refresh()}>
            {en ? 'Refresh login status' : '刷新登录状态'}
          </button>
          <p role="status">
            {ready
              ? en
                ? 'Login file ready. Select this account with the account switch action.'
                : '登录文件已就绪。现在可以在账号列表点「换成这个」。'
              : en
                ? 'Login file is not ready yet.'
                : '尚未读到可用的登录文件。'}
          </p>
          <p className="text-cafe-muted">
            {en
              ? 'For AGY Native personal subscriptions. Model and permissions stay in member settings.'
              : '用于 AGY Native 个人订阅。模型与权限继续在成员设置里管理。'}
          </p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <button className="account-button" type="button" disabled={busy} onClick={onClose}>
        {en ? 'Close' : '关闭'}
      </button>
    </dialog>,
    document.body,
  );
}
