'use client';
import { Fragment, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { AccountAddMenu } from './accounts/AccountAddMenu';
import { AccountDirectoryRow } from './accounts/AccountDirectoryRow';
import { AccountSwitchConfirm } from './accounts/AccountSwitchConfirm';
import {
  accountDisplayName,
  accountIsSelected,
  accountMembers,
  accountProvider,
} from './accounts/account-directory-view';
import { accountMessage } from './accounts/account-message';
import { accountsCopy } from './accounts/accounts.shell-copy';
import { ClaudeTokenModal } from './accounts/ClaudeTokenModal';
import { useAccountDirectory } from './accounts/useAccountDirectory';
import type { BuiltinAccountClient, ProfileAuthType, ProfileItem } from './hub-accounts.types';
import { normalizeBuiltinClientIds } from './hub-accounts.view';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';
import { type UnifiedAuthEditData, UnifiedAuthModal } from './UnifiedAuthModal';
import './accounts/account-directory.css';

export function HubAccountsTab({
  initialClientId,
  toolLabel,
}: {
  initialClientId?: BuiltinAccountClient;
  toolLabel?: string;
} = {}) {
  const t = useShellCopy(accountsCopy);
  const language = useShellLanguage();
  const directory = useAccountDirectory();
  const { cats } = useCatData();
  const [claudeModal, setClaudeModal] = useState<{ account?: ProfileItem }>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [addType, setAddType] = useState<ProfileAuthType>('oauth');
  const [editTarget, setEditTarget] = useState<UnifiedAuthEditData>();
  const [switchTarget, setSwitchTarget] = useState<ProfileItem>();
  const [actionError, setActionError] = useState<{ ref: string; message: string }>();
  const [brokenOpen, setBrokenOpen] = useState(false);
  const profiles = useMemo(() => normalizeBuiltinClientIds(directory.data?.providers ?? []), [directory.data]);
  const rows = profiles.map((account) => ({
    account,
    provider: accountProvider(account, t),
    members: accountMembers(
      account,
      cats,
      account.clientId === 'anthropic' ? directory.claudeSelection : directory.selection,
    ),
    used: accountIsSelected(
      account,
      cats,
      account.clientId === 'anthropic' ? directory.claudeSelection : directory.selection,
    ),
  }));
  const counts = {
    all: rows.length,
    oauth: rows.filter((r) => r.account.authType === 'oauth').length,
    api_key: rows.filter((r) => r.account.authType === 'api_key').length,
  };
  const sorted = rows.sort((a, b) => {
    const count = (provider: string) =>
      rows.filter((r) => r.provider === provider).reduce((n, r) => n + r.members.filter((m) => m.available).length, 0);
    return (
      count(b.provider) - count(a.provider) ||
      a.provider.localeCompare(b.provider) ||
      Number(b.used) - Number(a.used) ||
      a.account.displayName.localeCompare(b.account.displayName)
    );
  });
  const visible = sorted.filter(
    (row) =>
      (filter === 'all' || row.account.authType === filter) &&
      [
        row.provider,
        accountDisplayName(row.account, t),
        row.account.displayName,
        row.account.codex?.identity?.email ?? '',
        row.account.nativeLogin?.identity?.email ?? '',
        row.account.baseUrl ?? '',
        ...row.members.map((m) => `${m.name} ${m.searchText ?? ''}`),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const update = (next: ProfileItem[], removed?: string[]) => {
    directory.update(next, removed);
    if (actionError && (next.some((p) => p.id === actionError.ref) || removed?.includes(actionError.ref)))
      setActionError(undefined);
  };
  function edit(profile: ProfileItem) {
    if (profile.claude) {
      setClaudeModal({ account: profile });
      return;
    }
    setEditTarget({
      id: profile.id,
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      clientId: profile.clientId,
      authType: profile.authType,
      models: profile.models,
      envVars: profile.envVars,
    });
    setShowAuthModal(true);
  }
  if (directory.loading && !directory.data) return <p>{t.loading}</p>;
  return (
    <div className="account-directory">
      {toolLabel && (
        <p role="status">
          {language === 'zh'
            ? `正在管理 ${toolLabel} 的连接。使用工具已有配置时，无需重复添加认证。`
            : `Managing ${toolLabel} connections. Existing tool configuration needs no duplicate credentials.`}
        </p>
      )}
      <div className="account-toolbar">
        <input
          type="search"
          aria-label={t.search}
          placeholder={t.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="account-filters" role="group" aria-label={t.filters}>
          {(
            [
              ['all', t.all],
              ['oauth', t.oauth],
              ['api_key', t.apiKey],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label} {counts[value]}
            </button>
          ))}
        </div>
        <AccountAddMenu
          onAddClaude={() => setClaudeModal({})}
          onAdd={(type) => {
            setEditTarget(undefined);
            setAddType(type);
            setShowAuthModal(true);
          }}
        />
      </div>
      {directory.error && <p role="alert">{accountMessage(directory.error, language)}</p>}
      {(directory.memberError || directory.claudeMemberError) && <p role="status">{t.selectionUnknown}</p>}
      {directory.data?.nativeDefaultsError && (
        <p role="status">{accountMessage(directory.data.nativeDefaultsError, language)}</p>
      )}
      {(directory.error ||
        directory.memberError ||
        directory.claudeMemberError ||
        directory.data?.nativeDefaultsError) && (
        <button type="button" className="account-button" onClick={() => void directory.refresh()}>
          {t.retryRead}
        </button>
      )}
      {directory.selection?.state === 'mixed' && (
        <p className="account-notice">
          {t.mixed(
            new Set(directory.selection.members.filter((m) => m.available).map((m) => m.accountRef)).size,
            profiles
              .filter((p) => directory.selection?.members.some((m) => m.available && m.accountRef === p.id))
              .map(
                (p) =>
                  `${accountDisplayName(p, t)}${t.memberCount(directory.selection?.members.filter((m) => m.available && m.accountRef === p.id).length ?? 0)}`,
              )
              .join(language === 'zh' ? '，' : ', '),
          )}
        </p>
      )}
      <div role="group" aria-label={t.list} data-guide-id="accounts.account-list">
        {(['oauth', 'api_key'] as const).map((type) => {
          const section = visible.filter((r) => r.account.authType === type);
          if (!section.length) return null;
          return (
            <section key={type} className="account-section">
              <h3>
                {type === 'oauth' ? t.oauth : t.apiKey} · {section.length}
              </h3>
              <div className="account-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t.provider}</th>
                      <th>{t.account}</th>
                      <th>{t.status}</th>
                      <th>{t.usedBy}</th>
                      <th>{t.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.map((row, index) => (
                      <Fragment key={row.account.id}>
                        <AccountDirectoryRow
                          {...row}
                          provider={index === 0 || section[index - 1].provider !== row.provider ? row.provider : ''}
                          accounts={profiles}
                          refresh={directory.refresh}
                          update={update}
                          onSwitch={setSwitchTarget}
                          onEdit={edit}
                          actionError={
                            actionError?.ref === row.account.id && !row.account.codex?.attempt
                              ? t.loginUnconfirmed(accountMessage(actionError.message, language))
                              : undefined
                          }
                        />
                        {switchTarget?.id === row.account.id && (
                          <tr className="account-expanded">
                            <td colSpan={5}>
                              <AccountSwitchConfirm
                                account={switchTarget}
                                onClose={() => setSwitchTarget(undefined)}
                                onChanged={(next) => directory.applyBinding(next, switchTarget.clientId)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
        {!visible.length && <p className="account-empty">{query ? t.noMatch : t.empty}</p>}
      </div>
      {!!directory.data?.unavailableAccounts?.length && (
        <section className="account-rejected">
          <button type="button" aria-expanded={brokenOpen} onClick={() => setBrokenOpen(!brokenOpen)}>
            {t.rejectedCount(directory.data.unavailableAccounts.length)} {brokenOpen ? '⌃' : '⌄'}
          </button>
          {brokenOpen && (
            <ul>
              {directory.data.unavailableAccounts.map((row) => (
                <li key={row.accountRef}>
                  <strong>{row.accountRef}</strong>: {accountMessage(row.reason, language)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {claudeModal && (
        <ClaudeTokenModal
          account={claudeModal.account}
          onClose={() => setClaudeModal(undefined)}
          onSaved={(profile) => {
            update([profile]);
            void directory.refresh();
          }}
        />
      )}
      <UnifiedAuthModal
        key={editTarget?.id ?? `create-${addType}`}
        initialAuthType={addType}
        open={showAuthModal}
        editProfile={editTarget}
        initialClientId={editTarget ? undefined : initialClientId}
        onClose={() => {
          setShowAuthModal(false);
          setEditTarget(undefined);
        }}
        onCreated={(ref, error, profile) => {
          setShowAuthModal(false);
          setEditTarget(undefined);
          setActionError(error ? { ref, message: error } : undefined);
          if (profile) update([profile]);
          void directory.refresh();
        }}
      />
    </div>
  );
}
