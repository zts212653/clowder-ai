import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import { useId, useRef, useState } from 'react';
import styles from './search-group-picker.module.css';
import { groupTitle } from './search-group-types';

export function matchingGroup(groups: readonly ThreadAttentionGroup[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? groups.filter((group) =>
        /^f\d+$/.test(needle)
          ? new RegExp(`(^|[^a-z0-9])${needle}(?![a-z0-9])`, 'i').test(groupTitle(group))
          : groupTitle(group).toLocaleLowerCase().includes(needle),
      )
    : [];
}

export function SearchGroupPicker({
  groups,
  destination,
  onChange,
  matchQuery,
  recentGroupIds = [],
  matchedThreadIds,
  disabled,
}: {
  groups: readonly ThreadAttentionGroup[];
  destination: string;
  onChange: (id: string) => void;
  matchQuery: string;
  recentGroupIds?: readonly string[];
  matchedThreadIds: readonly string[];
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const visible = search.trim() ? matchingGroup(groups, search) : [...groups];
  const matching = matchingGroup(visible, search || matchQuery);
  const recent = visible
    .filter((group) => !matching.includes(group) && recentGroupIds.includes(group.id))
    .sort((a, b) => recentGroupIds.indexOf(a.id) - recentGroupIds.indexOf(b.id));
  const rest = visible.filter((group) => !matching.includes(group) && !recent.includes(group));
  const highlight = (name: string) => {
    const query = (search || matchQuery).trim();
    const index = query ? name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
    return index < 0 ? (
      name
    ) : (
      <>
        {name.slice(0, index)}
        <mark>{name.slice(index, index + query.length)}</mark>
        {name.slice(index + query.length)}
      </>
    );
  };
  return (
    <div className={styles.picker}>
      <input
        ref={input}
        aria-label="搜组名"
        role="combobox"
        aria-expanded="true"
        aria-controls={id}
        aria-autocomplete="list"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="搜组名…"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            list.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
          }
        }}
      />
      <div
        ref={list}
        id={id}
        role="listbox"
        aria-label="整理到"
        className={styles.list}
        onKeyDown={(event) => {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }
          if (event.key === 'Escape') {
            event.stopPropagation();
            input.current?.focus();
          }
        }}
      >
        {[
          ['名字对得上', matching],
          ['最近用过', recent],
          ['其他 Group', rest],
        ].map(([title, items]) =>
          (items as ThreadAttentionGroup[]).length ? (
            <div key={title as string} role="group" aria-label={title as string}>
              <div className={styles.heading}>{title as string}</div>
              {(items as ThreadAttentionGroup[]).map((group) => {
                const already = group.threadIds.filter((threadId) => matchedThreadIds.includes(threadId)).length;
                return (
                  <button
                    key={group.id}
                    type="button"
                    role="option"
                    aria-selected={destination === group.id}
                    disabled={disabled}
                    onClick={() => onChange(group.id)}
                  >
                    <span className={styles.check}>{destination === group.id ? '✓' : ''}</span>
                    <span className={styles.name}>{highlight(groupTitle(group))}</span>
                    <span className={styles.meta}>
                      {already ? `${already} 条已在组里` : `${group.threadIds.length} 条`}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null,
        )}
        {visible.length === 0 ? <p className={styles.empty}>没有匹配的 Group</p> : null}
        <button
          type="button"
          role="option"
          aria-selected={!destination}
          disabled={disabled}
          onClick={() => onChange('')}
          className={styles.create}
        >
          <span className={styles.check}>＋</span>新建 Group
        </button>
      </div>
    </div>
  );
}
