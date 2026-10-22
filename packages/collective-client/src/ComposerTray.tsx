import type { CollectiveRecipient } from './client-types.js';
import { useCollectiveText } from './collective-copy.js';

export function ComposerTray({
  recipientKind,
  entrust,
  responseRequested,
  onMention,
  onEntrust,
  onResponseRequested,
}: {
  readonly recipientKind: CollectiveRecipient['kind'];
  readonly entrust: boolean;
  readonly responseRequested: boolean;
  readonly onMention: () => void;
  readonly onEntrust: (value: boolean) => void;
  readonly onResponseRequested: (value: boolean) => void;
}) {
  const t = useCollectiveText();
  return (
    <div className="composer-tray">
      <button type="button" onClick={onMention}>
        @ {t('提到成员')}
      </button>
      {recipientKind === 'agent' && (
        <label>
          <input type="checkbox" checked={entrust} onChange={(event) => onEntrust(event.target.checked)} />
          {t('请求持续处理')}
        </label>
      )}
      {recipientKind === 'channel' && (
        <label>
          <input
            type="checkbox"
            checked={responseRequested}
            onChange={(event) => onResponseRequested(event.target.checked)}
          />
          {t('希望伙伴回应')}
        </label>
      )}
      {entrust && <small>{t('由猫的主人安排私人任务，结果回到这里。')}</small>}
      {responseRequested && <small>{t('只通知自愿值守回应请求的伙伴；普通消息仍会安静送达。')}</small>}
    </div>
  );
}
