'use client';

import { useRef } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import { AppTooltip } from '../AppTooltip';
import { knownCatName, ShellCatAvatar } from '../shell/ShellCatAvatar';
import { useShellCopy } from '../shell/shell-copy';
import { threadSignalsCopy } from './thread-signals.shell-copy';
import { useWholeSidebarSignalText } from './use-measured-sidebar-rows';

/** Two active faces and a first-name +N summary; the full canonical roster stays recoverable. */
export function ThreadSignalCats({ cats, showNames = true }: { cats: readonly string[]; showNames?: boolean }) {
  const { getCatById } = useCatData();
  const copy = useShellCopy(threadSignalsCopy);
  const unique = [...new Set(cats)];

  const identities = unique.map((catId) => {
    const cat = getCatById(catId);
    const name = knownCatName(catId, getCatById) ?? copy.unknownCat;
    const nickname = cat?.nickname || name;
    return {
      catId,
      known: !!cat,
      name,
      callName: nickname.split('·', 1)[0].trim(),
      full: nickname === name ? name : `${name} · ${nickname}`,
    };
  });
  const nameSlot = useRef<HTMLSpanElement>(null);
  const nameContent = useRef<HTMLSpanElement>(null);
  const fullRoster = identities.map((cat) => cat.full).join('\n');
  const nameFits = useWholeSidebarSignalText(nameSlot, nameContent, `${showNames}:${fullRoster}`);
  const first = identities[0];
  if (!first) return null;
  return (
    <AppTooltip label={fullRoster} side="right" intent="content" multiline>
      <span
        role="img"
        aria-label={identities.map((cat) => cat.name).join('、')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus recovers every active cat in the summarized roster.
        tabIndex={0}
        className={`shell-focusable flex items-center rounded-sm ${showNames ? 'flex-1 basis-0' : 'flex-none'}`}
        style={{ minWidth: unique.length > 1 ? 32 : 20 }}
        data-testid="thread-signal-cats"
      >
        <span data-signal-fixed="faces" className="inline-flex flex-none items-center px-0.5">
          {identities.slice(0, 2).map((cat, index) => (
            <span key={cat.catId} className={index ? '-ml-1' : undefined}>
              <ShellCatAvatar catId={cat.catId} size={16} />
            </span>
          ))}
        </span>
        {showNames && (
          <span
            ref={nameSlot}
            data-testid="thread-cat-name"
            aria-hidden={!nameFits}
            className="min-w-0 flex-1 overflow-hidden font-medium"
            style={{
              color: first.known ? catColorVar(first.catId, 'text') : 'var(--shell-muted)',
              visibility: nameFits ? 'visible' : 'hidden',
            }}
          >
            <span ref={nameContent} className="inline-flex whitespace-nowrap pl-1">
              <span>{first.callName}</span>
              {unique.length > 1 && (
                <span className="flex-none text-[var(--shell-muted)]" data-testid="thread-cats-more">
                  +{unique.length - 1}
                </span>
              )}
            </span>
          </span>
        )}
      </span>
    </AppTooltip>
  );
}
