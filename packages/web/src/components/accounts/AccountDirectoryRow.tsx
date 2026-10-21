'use client';
import { Fragment, useState } from 'react';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import { accountRequest } from '../codex-accounts/account-request';
import { CodexQuotaControl } from '../codex-accounts/CodexQuotaControl';
import { quotaCopy } from '../codex-accounts/quota.shell-copy';
import type { AccountMember, ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { useConfirm } from '../useConfirm';
import { AccountRowMenu } from './AccountRowMenu';
import { accountDisplayName, accountStatus } from './account-directory-view';
import { accountMessage } from './account-message';
import { accountsCopy } from './accounts.shell-copy';

export function AccountDirectoryRow({
  account,
  accounts,
  members,
  used,
  provider,
  refresh,
  update,
  onSwitch,
  onEdit,
  actionError,
}: {
  account: ProfileItem;
  accounts: ProfileItem[];
  members: AccountMember[];
  used: boolean;
  provider: string;
  refresh: () => Promise<void>;
  update: (profiles: ProfileItem[], removed?: string[]) => void;
  onSwitch: (profile: ProfileItem) => void;
  onEdit: (profile: ProfileItem) => void;
  actionError?: string;
}) {
  const t = useShellCopy(accountsCopy);
  const quota = useShellCopy(quotaCopy);
  const language = useShellLanguage();
  const displayName = accountDisplayName(account, t);
  const native = account.builtin && account.authType === 'oauth';
  const identityDetail = native
    ? account.nativeLogin?.officialDefault === false
      ? account.nativeLogin.home
      : t.nativeManaged
    : (account.codex?.identity?.email ?? account.baseUrl ?? '');
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(account.displayName);
  const status = accountStatus(account, t, language);
  const attempt = account.codex?.attempt;
  const waiting = ['preparing', 'queued', 'waiting'].includes(attempt?.state ?? '');
  const review = attempt?.state === 'review';
  const failed = ['failed', 'timeout', 'interrupted', 'canceled', 'superseded'].includes(attempt?.state ?? '');
  const active = members.filter((m) => m.available);
  const duplicate = accounts.find((p) => p.id === attempt?.duplicateAccountRef);
  const id = `account-row-${encodeURIComponent(account.id)}`;
  async function login(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ profiles: ProfileItem[] }>(
        `/api/accounts/${encodeURIComponent(account.id)}/codex/login/${action}`,
        { attemptId: attempt?.id, ...extra },
      );
      update(result.profiles);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      void refresh();
    } finally {
      setBusy(false);
    }
  }
  async function remove(focusRef?: string) {
    if (
      !focusRef &&
      !(await confirm({
        title: t.delete,
        variant: 'danger',
        confirmLabel: t.delete,
        cancelLabel: t.cancel,
        message: t.deleteMessage(displayName),
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await accountRequest(`/api/accounts/${encodeURIComponent(account.id)}`, {}, 'DELETE');
      update([], [account.id]);
      void refresh();
      if (focusRef) {
        const target = document.getElementById(`account-row-${encodeURIComponent(focusRef)}`);
        target?.scrollIntoView?.({ block: 'center' });
        target?.focus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }
  async function rename() {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ profile: ProfileItem }>(
        `/api/accounts/${encodeURIComponent(account.id)}`,
        { displayName: note },
        'PATCH',
      );
      update([result.profile]);
      setEditing(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    } finally {
      setBusy(false);
    }
  }
  const action = review
    ? 'handle'
    : waiting
      ? 'cancel'
      : account.codex && (failed || !status.ready)
        ? 'retry'
        : (status.ready || (native && account.clientId === 'anthropic')) && !used
          ? 'switch'
          : '';
  return (
    <Fragment>
      <tr data-account-id={account.id} id={id} tabIndex={-1}>
        <td className="account-provider" title={provider}>
          {provider}
        </td>
        <td>
          <button
            type="button"
            className="account-name"
            title={displayName}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {displayName}
          </button>
          <small className="account-cell-text" title={identityDetail}>
            {identityDetail}
          </small>
        </td>
        <td>
          <span className={`account-state ${status.ready ? 'account-state-ready' : ''}`}>{status.label}</span>
          <small className="account-cell-text" title={status.detail}>
            {status.detail}
          </small>
        </td>
        <td className="account-quota-cell">
          {account.clientId === 'openai' && account.authType === 'oauth' ? (
            status.ready ? (
              <CodexQuotaControl
                accountRef={account.id}
                observation={account.quota}
                reload={refresh}
                managed={!!account.codex}
                identity={account.codex?.identity}
              />
            ) : (
              <small>{t.noQuota}</small>
            )
          ) : (
            <small>{account.authType === 'api_key' ? t.providerBalance : quota.unsupported}</small>
          )}
        </td>
        <td>
          <div className="account-followers">
            {used && <span className="account-used">{t.inUse}</span>}
            {!used && active.some((m) => m.bindingMode === 'override') && (
              <span className="account-binding" title={t.override}>
                {t.override}
              </span>
            )}
            {active.slice(0, 5).map((m) => (
              <AvatarImageWithFallback
                key={m.id}
                src={m.avatar ?? '/avatars/codex.png'}
                alt={m.name}
                className="account-avatar"
              />
            ))}
            <span>{active.length ? t.memberCount(active.length) : '—'}</span>
          </div>
        </td>
        <td>
          <div className="account-row-actions">
            {action && (
              <button
                type="button"
                className="account-button"
                disabled={busy}
                onClick={() =>
                  review
                    ? setOpen(true)
                    : waiting
                      ? void login('cancel')
                      : action === 'retry'
                        ? void login('start')
                        : onSwitch(account)
                }
              >
                {t[action]}
              </button>
            )}
            <AccountRowMenu
              account={account}
              busy={busy}
              used={used}
              memberCount={members.length}
              canRelogin={!waiting && !review}
              onRename={() => {
                setNote(account.displayName);
                setEditing(true);
                setOpen(true);
              }}
              onRelogin={() => void login('start')}
              onEdit={() => onEdit(account)}
              onDelete={() => void remove()}
            />
            <button
              type="button"
              className="account-expand"
              aria-label={t.expand(displayName)}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? '⌃' : '⌄'}
            </button>
          </div>
        </td>
      </tr>
      {(open || error || actionError) && (
        <tr className="account-expanded">
          <td colSpan={6}>
            {(error || actionError) && <p role="alert">{error ? accountMessage(error, language) : actionError}</p>}
            {open && (
              <div className="account-details">
                {account.claude && <p>{t.tokenUnknown}</p>}
                {editing && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename();
                    }}
                  >
                    <input
                      aria-label={t.renameLabel}
                      maxLength={200}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button type="submit" className="account-button" disabled={busy}>
                      {t.save}
                    </button>
                    <button type="button" className="account-button" onClick={() => setEditing(false)}>
                      {t.cancel}
                    </button>
                  </form>
                )}
                <p>{t.followers(active.map((m) => m.name).join(language === 'zh' ? '、' : ', ') || t.none)}</p>
                {active.some((m) => m.bindingMode === 'override') && <p>{t.overrideNotice}</p>}
                {review && (
                  <div className="account-identity-review">
                    {attempt?.duplicateAccountRef && !duplicate ? (
                      <>
                        <p>{t.duplicateMissing}</p>
                        <button
                          type="button"
                          className="account-button"
                          disabled={busy}
                          onClick={() => void login('cancel')}
                        >
                          {t.abandonLogin}
                        </button>
                      </>
                    ) : duplicate && !account.codex?.identity ? (
                      <>
                        <p>{t.duplicate(accountDisplayName(duplicate, t))}</p>
                        <button
                          type="button"
                          className="account-button"
                          disabled={busy || members.length > 0}
                          onClick={() => void remove(duplicate.id)}
                        >
                          {t.returnTo(accountDisplayName(duplicate, t))}
                        </button>
                        <button type="button" className="account-button" onClick={() => setOpen(false)}>
                          {t.keep}
                        </button>
                      </>
                    ) : (
                      <>
                        <p>{t.newIdentity(attempt?.identity?.email ?? t.officialIdentity)}</p>
                        {!duplicate && (
                          <button
                            type="button"
                            className="account-button"
                            disabled={busy}
                            onClick={() => void login('create-new', { displayName: t.newName(account.displayName) })}
                          >
                            {t.saveNew}
                          </button>
                        )}
                        {duplicate && <p>{t.identityExists(accountDisplayName(duplicate, t))}</p>}
                        <button
                          type="button"
                          className="account-button"
                          disabled={busy}
                          onClick={() => void login('cancel')}
                        >
                          {t.abandonLogin}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {(account.codex || account.nativeLogin) && (
                  <details>
                    <summary>{t.loginDetails}</summary>
                    <p>
                      {t.loginDirectory}: {account.codex?.credentialHome ?? account.nativeLogin?.home}
                    </p>
                    {(account.codex?.identity?.workspaceId ?? account.nativeLogin?.identity?.workspaceId) && (
                      <p>
                        {t.workspaceId}:{' '}
                        {account.codex?.identity?.workspaceId ?? account.nativeLogin?.identity?.workspaceId}
                      </p>
                    )}
                  </details>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
