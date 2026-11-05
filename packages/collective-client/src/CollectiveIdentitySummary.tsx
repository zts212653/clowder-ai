import type { MouseEvent } from 'react';
import type { CollectiveHuman, CollectiveHumanAuth, CollectiveParticipant } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { MemberAvatar } from './MemberAvatar.js';

export interface CollectiveIdentity {
  readonly human: Pick<CollectiveHuman, 'humanId' | 'displayName' | 'avatarUrl'>;
  readonly auth: CollectiveHumanAuth | null;
  readonly cats?: readonly Pick<CollectiveParticipant, 'connectionId' | 'catId' | 'displayName' | 'avatarDataUrl'>[];
}

export function CollectiveIdentitySummary({
  collectiveName,
  identity,
  onOpenSelf,
  onSwitchAccount,
}: {
  readonly collectiveName: string;
  readonly identity: CollectiveIdentity;
  readonly onOpenSelf: () => void;
  readonly onSwitchAccount: () => void;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const act = (callback: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    callback();
  };
  return (
    <details className="collective-identity">
      <summary
        aria-label={
          language === 'en'
            ? `Current identity: ${identity.human.displayName}`
            : `当前身份：${identity.human.displayName}`
        }
      >
        <MemberAvatar name={identity.human.displayName} kind="human" avatarUrl={identity.human.avatarUrl} compact />
        <span>{identity.human.displayName}</span>
      </summary>
      <div className="collective-identity-card">
        <div className="collective-identity-who">
          <MemberAvatar name={identity.human.displayName} kind="human" avatarUrl={identity.human.avatarUrl} compact />
          <div>
            <p>
              {language === 'en' ? `You are ` : `你在${collectiveName}里是`}
              <strong>{identity.human.displayName}</strong>
              {language === 'en' ? ` in ${collectiveName}` : ''}
            </p>
            {identity.auth && (
              <small>
                {language === 'en'
                  ? `Signed in with GitHub as @${identity.auth.handle}`
                  : `用 GitHub 账号 @${identity.auth.handle} 登录`}
              </small>
            )}
          </div>
        </div>
        <section className="collective-identity-cats" aria-label={t('你的猫在这里')}>
          <h2>{t('你的猫在这里')}</h2>
          {identity.cats === undefined ? (
            <p>{t('正在读取我的猫…')}</p>
          ) : identity.cats.length ? (
            <ul>
              {identity.cats.map((cat) => (
                <li key={`${cat.connectionId}:${cat.catId}`}>
                  <MemberAvatar name={cat.displayName} kind="agent" avatarUrl={cat.avatarDataUrl} compact />
                  <span>{cat.displayName}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('当前没有登记到这里的猫。')}</p>
          )}
        </section>
        <div className="collective-identity-actions">
          <button type="button" onClick={act(onOpenSelf)}>
            {t('看我的成员资料')}
          </button>
          <button type="button" onClick={act(onSwitchAccount)}>
            {t('换账号…')}
          </button>
        </div>
      </div>
    </details>
  );
}
