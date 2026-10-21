'use client';
import { useId, useRef } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import type { ConfigData } from '../config-viewer-types';
import type { RoutingContextQueryState } from '../routing-context/useRoutingContext';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { MemberAccountName } from './MemberAccountName';
import { MemberIdentityDetails } from './MemberIdentityDetails';
import { MemberRuntimeSummary } from './MemberRuntimeSummary';
import { MemberStatus } from './MemberStatus';
import { memberStatus, memberTransport } from './member-projection';
import { useMemberClock } from './useMemberClock';
import type { useMemberList } from './useMemberList';
import { useMemberLoginCheck } from './useMemberLoginCheck';
export function MemberTable({
  config,
  visible,
  list,
  routing,
  filter,
  transport,
  onEditMember,
  onEditCoCreator,
  onToggleAvailability,
  togglingCatId,
}: {
  config: ConfigData;
  cats: CatData[];
  visible: CatData[];
  list: ReturnType<typeof useMemberList>;
  routing: RoutingContextQueryState;
  filter: string;
  transport: string;
  onEditMember: (cat: CatData) => void;
  onEditCoCreator: () => void;
  onToggleAvailability: (cat: CatData) => void;
  togglingCatId: string | null;
}) {
  const dragging = useRef<string | null>(null);
  const sortHelpId = useId();
  const t = useMemberText();
  const copy = useMembersCopy();
  const now = useMemberClock(routing.data);
  const loginFor = useMemberLoginCheck(list.allCats.some((cat) => cat.configurationSource === 'native_tool'));
  return (
    <div className="member-table-scroll">
      <p id={sortHelpId} className="sr-only">
        {t('拖动左侧排序；键盘用上下方向键')}
      </p>
      <table className="member-table">
        <thead>
          <tr>
            <th aria-label={t('排序')} />
            <th>{t('成员')}</th>
            <th>{t('模型')}</th>
            <th>{t('账号')}</th>
            <th>{t('接入方式')}</th>
            <th>{t('现在')}</th>
            <th>{t('@ 名字')}</th>
            <th>{t('启用')}</th>
          </tr>
        </thead>
        <tbody>
          {config.coCreator && filter !== 'disabled' && transport === 'all' && (
            <tr>
              <td />
              <td>
                <button type="button" className="member-name" onClick={onEditCoCreator}>
                  {config.coCreator.name} <small>{t('所有者')}</small>
                </button>
              </td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>{config.coCreator.mentionPatterns?.[0] ?? '—'}</td>
              <td>—</td>
            </tr>
          )}
          {visible.map((cat) => (
            <tr
              key={cat.id}
              data-cat-id={cat.id}
              draggable={!list.savingOrder}
              onDragStart={(event) => {
                dragging.current = cat.id;
                event.dataTransfer.setData('text/plain', cat.id);
              }}
              onDragEnd={() => {
                dragging.current = null;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging.current) void list.move(dragging.current, cat.id);
                dragging.current = null;
              }}
            >
              <td>
                <button
                  type="button"
                  className="member-sort"
                  aria-label={copy.sortLabel(cat.nickname || cat.displayName)}
                  aria-describedby={sortHelpId}
                  disabled={list.savingOrder}
                  onKeyDown={(event) => {
                    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                    event.preventDefault();
                    const i = list.allCats.findIndex((c) => c.id === cat.id);
                    const target = list.allCats[i + (event.key === 'ArrowUp' ? -1 : 1)];
                    if (target) void list.move(cat.id, target.id);
                  }}
                >
                  ⠿
                </button>
                <div className="member-sort-touch">
                  <button
                    type="button"
                    aria-label={copy.upLabel(cat.displayName)}
                    disabled={list.savingOrder || list.allCats[0]?.id === cat.id}
                    onClick={() => {
                      const i = list.allCats.findIndex((c) => c.id === cat.id);
                      if (i > 0) void list.move(cat.id, list.allCats[i - 1].id);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={copy.downLabel(cat.displayName)}
                    disabled={list.savingOrder || list.allCats.at(-1)?.id === cat.id}
                    onClick={() => {
                      const i = list.allCats.findIndex((c) => c.id === cat.id);
                      if (list.allCats[i + 1]) void list.move(cat.id, list.allCats[i + 1].id);
                    }}
                  >
                    ↓
                  </button>
                </div>
              </td>
              <td>
                <button type="button" className="member-name" onClick={() => onEditMember(cat)}>
                  <AvatarImageWithFallback src={cat.avatar} alt="" className="member-avatar" />
                  <span>
                    <strong>{cat.nickname || cat.displayName}</strong>
                    <small>{cat.breedDisplayName || cat.displayName}</small>
                  </span>
                </button>
                <MemberIdentityDetails cat={cat} onEdit={() => onEditMember(cat)} />
              </td>
              <td>
                <MemberRuntimeSummary cat={cat} />
              </td>
              <td>
                <MemberAccountName cat={cat} accounts={list.accounts} />
              </td>
              <td>{t(memberTransport(cat))}</td>
              <td>
                <MemberStatus
                  status={
                    routing.loading && !routing.data
                      ? { label: '读取中', detail: '', tone: 'unknown' }
                      : memberStatus(cat, routing.data, routing.error, now, loginFor(cat))
                  }
                />
              </td>
              <td>
                <details className="member-aliases">
                  <summary>
                    {cat.mentionPatterns.length
                      ? copy.aliasCount(cat.mentionPatterns[0], cat.mentionPatterns.length)
                      : t('未设置')}
                  </summary>
                  <div>{cat.mentionPatterns.join('、')}</div>
                </details>
              </td>
              <td>
                <button
                  type="button"
                  className="member-switch"
                  role="switch"
                  aria-checked={cat.roster?.available !== false}
                  aria-label={copy.enableLabel(cat.nickname || cat.displayName)}
                  disabled={togglingCatId === cat.id}
                  onClick={() => onToggleAvailability(cat)}
                >
                  <span />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
