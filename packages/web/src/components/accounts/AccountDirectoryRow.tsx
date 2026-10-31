'use client';
import type { AccountQuotaObservation } from '@cat-cafe/shared';
import { Fragment, useState } from 'react';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import { accountRequest } from '../codex-accounts/account-request';
import { CodexQuotaControl } from '../codex-accounts/CodexQuotaControl';
import { QuotaQueryDetails } from '../codex-accounts/QuotaQueryFeedback';
import { quotaCopy } from '../codex-accounts/quota.shell-copy';
import { nextQuotaAccount } from '../codex-accounts/quota-state';
import type { AccountMember, ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { useConfirm } from '../useConfirm';
import { AccountLoginDetails } from './AccountLoginDetails';
import { AccountRowActions } from './AccountRowActions';
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
  const [latestQuery, setLatestQuery] = useState<AccountQuotaObservation | undefined>(account.quota);
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
  const suggestion = used ? nextQuotaAccount(account, accounts) : undefined;
  const action = review
    ? 'handle'
    : waiting
      ? 'cancel'
      : account.codex && (failed || !status.ready)
        ? 'retry'
        : (status.ready || (native && account.clientId === 'anthropic')) && (!used || !!suggestion)
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
            status.ready || account.quota?.status === 'unavailable' ? (
              <CodexQuotaControl
                accountRef={account.id}
                inUse={used}
                switchSuggestion={
                  suggestion ? { name: accountDisplayName(suggestion.account, t), left: suggestion.left } : undefined
                }
                allowReading={status.ready}
                observation={account.quota}
                reload={refresh}
                managed={!!account.codex}
                identity={
                  account.codex?.identity ??
                  (account.nativeLogin?.identity?.userId
                    ? { ...account.nativeLogin.identity, userId: account.nativeLogin.identity.userId }
                    : undefined)
                }
                onObservation={setLatestQuery}
                onRelogin={account.codex && !waiting && !review ? () => void login('start') : undefined}
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
          <AccountRowActions
            account={account}
            busy={busy}
            used={used}
            memberCount={members.length}
            label={
              action === 'switch' && suggestion
                ? quota.switchTo(accountDisplayName(suggestion.account, t))
                : action
                  ? t[action]
                  : ''
            }
            open={open}
            canRelogin={!waiting && !review}
            onAction={() =>
              review
                ? setOpen(true)
                : waiting
                  ? void login('cancel')
                  : action === 'retry'
                    ? void login('start')
                    : onSwitch(suggestion?.account ?? account)
            }
            onRename={() => {
              setNote(account.displayName);
              setEditing(true);
              setOpen(true);
            }}
            onRelogin={() => void login('start')}
            onEdit={() => onEdit(account)}
            onDelete={() => void remove()}
            onExpand={() => setOpen(!open)}
            expandLabel={t.expand(displayName)}
          />
        </td>
      </tr>
      {(open || error || actionError) && (
        <tr className="account-expanded">
          <td colSpan={6}>
            {(error || actionError) && <p role="alert">{error ? accountMessage(error, language) : actionError}</p>}
            {open && (
              <div className="account-details">
                <QuotaQueryDetails observation={latestQuery} />
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
                <AccountLoginDetails account={account} />
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
