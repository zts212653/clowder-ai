import { collectiveMessageQuoteSchema, type RichInteractiveBlock } from '@cat-cafe/shared';
import { CafeIcon, ChoiceOptionContent } from '@cat-cafe/ui';
import { Fragment, useState } from 'react';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { useMessageQuotes } from './message-quote-context.js';

export function MessageChoices({ block, event }: { block: RichInteractiveBlock; event: CollectiveEventEnvelope }) {
  const namespace = useMessageQuotes()?.namespace;
  return <MessageChoiceForm key={`${namespace ?? ''}:${event.eventId}:${block.id}`} block={block} event={event} />;
}
function MessageChoiceForm({ block, event }: { block: RichInteractiveBlock; event: CollectiveEventEnvelope }) {
  const en = useCollectiveLanguage() === 'en';
  const actions = useMessageQuotes();
  const key = actions?.namespace && `collective-choice:${actions.namespace}:${event.eventId}:${block.id}`;
  const [selection, setSelection] = useState<{ ids: string[]; text: string }>(() => {
    try {
      const saved: unknown = key && JSON.parse(localStorage.getItem(key) ?? 'null');
      if (
        saved &&
        typeof saved === 'object' &&
        'ids' in saved &&
        Array.isArray(saved.ids) &&
        saved.ids.every((id) => typeof id === 'string' && block.options.some((option) => option.id === id)) &&
        'text' in saved &&
        typeof saved.text === 'string'
      )
        return { ids: saved.ids, text: saved.text };
    } catch {
      /* The public source remains readable if private form storage is unavailable. */
    }
    return { ids: block.selectedIds ?? [], text: '' };
  });
  const [notice, setNotice] = useState<string>();
  const edit = (next: typeof selection) => {
    setSelection(next);
    if (key)
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        setNotice(en ? 'This selection could not be saved on this device' : '这台设备未能保存选择，请保留当前页面');
      }
  };
  const many = block.interactiveType === 'multi-select';
  const selected = block.options.filter((option) => selection.ids.includes(option.id));
  const custom = selected.find((option) => option.customInput);
  const submit = () => {
    if (!actions || !event.location) return;
    const quote = collectiveMessageQuoteSchema.safeParse({
      v: 1,
      kind: 'quote',
      id: `ctx_${crypto.randomUUID()}`,
      text: [block.title, block.description, block.options.map((option) => option.label).join(' · ')]
        .filter(Boolean)
        .join('\n'),
      comment: `${
        block.messageTemplate
          ? block.messageTemplate.replace('{selection}', selected.map((option) => option.label).join(', '))
          : selected.map((option) => option.label).join(' · ')
      }${custom && selection.text.trim() ? `：${selection.text.trim()}` : ''}`,
      source: {
        kind: 'collective_message',
        serviceInstanceId: event.serviceInstanceId,
        collectiveId: event.collectiveId,
        channelId: event.location.channelId,
        eventId: event.eventId,
      },
    });
    if (!quote.success) {
      setNotice(en ? 'Selection is too long for one reply' : '这次选择太长，请缩短后放进草稿');
      return;
    }
    actions.add(quote.data);
    setNotice(en ? 'Added to your reply draft · Send when ready' : '已放进回复草稿 · 写好后由你发送');
  };
  return (
    <section className="cafe-message-choices">
      {block.title && <h4>{block.title}</h4>}
      {block.description && <p>{block.description}</p>}
      <div className="cafe-choice-options" data-choice-layout={block.interactiveType}>
        {block.options.map((option, index) => (
          <Fragment key={option.id}>
            {option.group && option.group !== block.options[index - 1]?.group && (
              <div className="cafe-choice-group">{option.group}</div>
            )}
            <button
              type="button"
              style={option.level ? { marginInlineStart: Math.min(6, Math.max(0, option.level)) * 8 } : undefined}
              aria-pressed={selection.ids.includes(option.id)}
              disabled={
                !actions ||
                block.disabled ||
                (many &&
                  !selection.ids.includes(option.id) &&
                  selection.ids.length >= (block.maxSelect ?? block.options.length))
              }
              onClick={() =>
                edit({
                  ...selection,
                  ids: many
                    ? selection.ids.includes(option.id)
                      ? selection.ids.filter((id) => id !== option.id)
                      : [...selection.ids, option.id]
                    : [option.id],
                })
              }
            >
              {option.icon ? (
                <CafeIcon name={option.icon} />
              ) : (
                option.emoji && <span aria-hidden="true">{option.emoji}</span>
              )}
              <ChoiceOptionContent
                label={option.label}
                description={option.description}
                selected={selection.ids.includes(option.id)}
              />
            </button>
          </Fragment>
        ))}
      </div>
      {actions && !block.disabled && block.allowRandom && block.options.length > 0 && (
        <button
          type="button"
          onClick={() => edit({ ids: [block.options[Math.floor(Math.random() * block.options.length)]!.id], text: '' })}
        >
          {en ? 'Pick one for me' : '帮我选一个'}
        </button>
      )}
      {custom && (
        <input
          aria-label={custom.label}
          placeholder={custom.customInputPlaceholder}
          maxLength={2000}
          disabled={!actions || block.disabled}
          value={selection.text}
          onChange={(event) => edit({ ...selection, text: event.target.value })}
        />
      )}
      {actions && !block.disabled && (
        <button type="button" disabled={!selected.length || Boolean(custom && !selection.text.trim())} onClick={submit}>
          {en ? 'Add to reply draft' : '放进回复草稿'}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
