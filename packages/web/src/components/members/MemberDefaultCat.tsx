import { useId } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { HelpTip } from '../settings/HelpTip';
import { useMemberText } from './editor-presentation';
import type { useMemberList } from './useMemberList';

export function MemberDefaultCat({ cats, list }: { cats: CatData[]; list: ReturnType<typeof useMemberList> }) {
  const id = useId();
  const t = useMemberText();
  return (
    <>
      <div className="member-default-control">
        <span className="inline-flex items-center gap-2">
          <label htmlFor={id}>
            <strong>{t('默认猫')}</strong>
          </label>
          <HelpTip topic={t('默认猫')}>{t('新对话里没有 @ 谁时，由这只猫回复')}</HelpTip>
        </span>
        <select
          id={id}
          aria-label={t('默认猫')}
          value={list.defaultId}
          disabled={list.defaultLoading || list.savingDefault || !list.defaultKnown}
          onChange={(event) => void list.saveDefault(event.target.value)}
        >
          {!list.defaultId && <option value="">{list.defaultLoading ? t('正在读取…') : t('未确认')}</option>}
          {list.defaultId && !cats.some((c) => c.id === list.defaultId) && (
            <option value={list.defaultId}>{t('当前默认猫不在名单中')}</option>
          )}
          {cats
            .filter((cat) => cat.roster?.available !== false || cat.id === list.defaultId)
            .map((cat) => (
              <option key={cat.id} value={cat.id} disabled={cat.roster?.available === false}>
                {cat.nickname || cat.displayName} · {cat.defaultModel}
                {cat.roster?.available === false ? t('（已停用）') : ''}
              </option>
            ))}
        </select>
      </div>
      {list.defaultError && (
        <p role="alert">
          {t(list.defaultError)}{' '}
          <button
            type="button"
            className="member-button"
            disabled={list.defaultLoading || list.savingDefault}
            onClick={() => void list.retryDefault()}
          >
            {t('重试')}
          </button>
        </p>
      )}
    </>
  );
}
