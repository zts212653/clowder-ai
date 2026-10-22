import { useCollectiveText } from './collective-copy.js';
import { MemberAvatar } from './MemberAvatar.js';

export function ComposerMentionMenu({
  options,
  id,
  active,
  onSelect,
}: {
  readonly options: readonly {
    key: string;
    label: string;
    detail: string;
    kind: 'human' | 'agent';
    avatarUrl?: string;
  }[];
  readonly id: string;
  readonly active: number;
  readonly onSelect: (index: number) => void;
}) {
  const t = useCollectiveText();
  return (
    <div className="mention-list" id={id} role="listbox" aria-label={t('选择要提到的成员')}>
      {options.map((option, index) => (
        <button
          key={option.key}
          id={`${id}-${index}`}
          type="button"
          role="option"
          aria-selected={index === active}
          className="mention-option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(index)}
        >
          <MemberAvatar name={option.label} kind={option.kind} avatarUrl={option.avatarUrl} compact />
          <span>
            <strong>{option.label}</strong>
            <small>{option.detail}</small>
          </span>
        </button>
      ))}
      {!options.length && <p>{t('没有找到在本频道参与的成员。')}</p>}
    </div>
  );
}
