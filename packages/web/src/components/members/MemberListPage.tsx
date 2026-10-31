'use client';

import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ConfigData } from '../config-viewer-types';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { MemberDefaultCat } from './MemberDefaultCat';
import { MemberPreferencesSummary } from './MemberPreferencesSummary';
import { MemberTable } from './MemberTable';
import { memberTransport } from './member-projection';
import { useMemberList } from './useMemberList';
import './members.css';

export function MemberListPage({
  registryLoading = false,
  registryKnown = true,
  onRetryRegistry,
  config,
  cats,
  onAddMember,
  onDetectMembers,
  onEditMember,
  onEditCoCreator,
  onToggleAvailability,
  togglingCatId,
}: {
  registryLoading?: boolean;
  registryKnown?: boolean;
  onRetryRegistry?: () => void;
  config: ConfigData;
  cats: CatData[];
  onAddMember: () => void;
  onDetectMembers?: () => void;
  onEditMember: (cat: CatData) => void;
  onEditCoCreator: () => void;
  onToggleAvailability: (cat: CatData) => void;
  togglingCatId: string | null;
}) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const list = useMemberList(cats);
  const routing = useRoutingContext();
  const [filter, setFilter] = useState('all');
  const [transport, setTransport] = useState('all');
  const visible = list.allCats.filter(
    (cat) =>
      (filter === 'all' || (cat.roster?.available === false ? filter === 'disabled' : filter === 'enabled')) &&
      (transport === 'all' || memberTransport(cat) === transport),
  );
  return (
    <section className="members-v2 member-list" data-testid="member-list-page">
      <header className="member-list-heading">
        <div>
          <h2>{t('成员与运行时')}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="member-button" onClick={onAddMember} data-testid="member-add">
            {t('添加成员')}
          </button>
          {cats.length === 0 && (
            <button
              type="button"
              className="member-button member-primary"
              onClick={onDetectMembers ?? onAddMember}
              data-testid="member-detect-empty-roster"
            >
              {t('一键检测并添加伙伴')}
            </button>
          )}
        </div>
      </header>
      <div className="member-defaults">
        <MemberDefaultCat cats={cats} list={list} />
        <MemberPreferencesSummary routing={routing} cats={cats} />
      </div>
      <div className="member-filters">
        <div role="group" aria-label={t('成员筛选')}>
          {[
            ['all', '全部'],
            ['enabled', '已启用'],
            ['disabled', '已停用'],
          ].map(([id, label]) => (
            <button
              type="button"
              className="member-button"
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {copy.filterCount(
                t(label),
                cats.filter(
                  (c) => id === 'all' || (c.roster?.available === false ? id === 'disabled' : id === 'enabled'),
                ).length,
              )}
            </button>
          ))}
        </div>
        <label>
          {t('接入方式')}{' '}
          <select
            value={transport}
            onChange={(event) => setTransport(event.target.value)}
            aria-label={t('接入方式筛选')}
          >
            {['all', 'CLI', 'App Server', 'ACP', '云端'].map((id) => (
              <option key={id} value={id}>
                {t(id === 'all' ? '全部' : id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.orderError && (
        <p role="alert" className="member-error">
          {t(list.orderError)}
        </p>
      )}
      {routing.error && (
        <p role="alert">
          {t('当前状态读取失败')}{' '}
          <button type="button" className="member-button" onClick={() => void routing.refresh()}>
            {t('重试')}
          </button>
        </p>
      )}
      <MemberTable
        config={config}
        cats={cats}
        visible={visible}
        list={list}
        routing={routing}
        filter={filter}
        transport={transport}
        onEditMember={onEditMember}
        onEditCoCreator={onEditCoCreator}
        onToggleAvailability={onToggleAvailability}
        togglingCatId={togglingCatId}
      />
      {visible.length === 0 && (
        <div className="member-empty">
          <p>
            {t(
              !registryKnown
                ? registryLoading
                  ? '正在读取成员名单…'
                  : '成员名单读取失败'
                : cats.length === 0
                  ? '没有成员'
                  : '没有符合筛选的成员',
            )}
          </p>
          {!registryKnown && !registryLoading && (
            <button type="button" className="member-button" onClick={onRetryRegistry}>
              {t('重试')}
            </button>
          )}
          {cats.length > 0 && (
            <button
              type="button"
              className="member-button"
              onClick={() => {
                setFilter('all');
                setTransport('all');
              }}
            >
              {t('清除筛选')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
