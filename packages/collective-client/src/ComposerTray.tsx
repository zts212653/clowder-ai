import type { CollectiveRecipient } from './client-types.js';

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
  return (
    <div className="composer-tray">
      <button type="button" onClick={onMention}>
        @ 提到成员
      </button>
      {recipientKind === 'agent' && (
        <label>
          <input type="checkbox" checked={entrust} onChange={(event) => onEntrust(event.target.checked)} />
          请求持续处理
        </label>
      )}
      {recipientKind === 'channel' && (
        <label>
          <input
            type="checkbox"
            checked={responseRequested}
            onChange={(event) => onResponseRequested(event.target.checked)}
          />
          希望伙伴回应
        </label>
      )}
      {entrust && <small>由猫的主人安排私人工作，结果回到这里。</small>}
      {responseRequested && <small>只通知自愿值守回应请求的伙伴；普通消息仍会安静送达。</small>}
    </div>
  );
}
