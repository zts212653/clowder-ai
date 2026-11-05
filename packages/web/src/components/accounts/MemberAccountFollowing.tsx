'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountSelection, ProfileItem } from '../hub-accounts.types';
import { useMemberText } from '../members/editor-presentation';
import { accountLoginReady } from './account-directory-view';

export function MemberAccountFollowing({
  accountRef,
  accounts,
  onFollow,
}: {
  accountRef: string;
  accounts: ProfileItem[];
  onFollow: (ref: string) => void;
}) {
  const t = useMemberText();
  const [selection, setSelection] = useState<AccountSelection>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void apiFetch('/api/accounts/codex/members')
      .then(async (response) => {
        if (!response.ok) throw new Error('selection_unavailable');
        const body = (await response.json()) as { selection?: AccountSelection };
        if (current) setSelection(body.selection);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <div className="member-helper">
      {selection?.accountRef ? (
        <>
          <span>{t(accountRef === selection.accountRef ? '跟随这一家正在用的账号' : '这个号会单独指定给这只猫')}</span>{' '}
          <button
            type="button"
            className="member-button"
            disabled={
              !accounts.some(
                (p) => p.id === selection.accountRef && (p.authType === 'api_key' ? p.hasApiKey : accountLoginReady(p)),
              )
            }
            onClick={() => onFollow(selection.accountRef!)}
          >
            {t('恢复跟随')}
          </button>
        </>
      ) : (
        <span>
          {t(failed ? '正在用的账号读不到。' : selection ? '这一家正在用的账号还没选定。' : '正在读取这一家用的账号…')}
        </span>
      )}{' '}
      <a href="/settings?s=accounts" target="_blank" rel="noreferrer">
        {t('添加或登录账号 ↗')}
      </a>
      <small>{t('账号页在新标签页打开，这里的草稿会保留。保存成员后生效。')}</small>
    </div>
  );
}
