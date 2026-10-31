import { useEffect, useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveText } from './collective-copy.js';

const emptyFilters = { query: '', channel: '', media: 'all', sort: 'recent' };

export function useArtifactLibraryFilters(
  catalogue: readonly SharedArtifact[],
  channelId?: string,
  requestedChannel?: { channelId: string; revision: number },
) {
  const [filters, setFilters] = useState(emptyFilters);
  useEffect(() => {
    if (requestedChannel) setFilters((current) => ({ ...current, channel: requestedChannel.channelId }));
  }, [requestedChannel]);
  const update = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const channelWorks = catalogue.filter((item) => !channelId || item.sourceLocation.channelId === channelId);
  const query = filters.query.trim().toLocaleLowerCase();
  const artifacts = channelWorks
    .filter(
      (item) =>
        (!filters.channel || item.sourceLocation.channelId === filters.channel) &&
        (filters.media === 'all' || item.mediaType.startsWith(filters.media)) &&
        item.title.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) =>
      filters.sort === 'name'
        ? a.title.localeCompare(b.title, 'zh-CN')
        : (b.versions.at(-1)?.recordedAt ?? '').localeCompare(a.versions.at(-1)?.recordedAt ?? '') ||
          a.artifactId.localeCompare(b.artifactId),
    );
  return { filters, update, artifacts, channelWorks, clear: () => setFilters(emptyFilters) };
}

export function SharedArtifactLibraryFilters({
  model,
  channelId,
}: {
  readonly model: ReturnType<typeof useArtifactLibraryFilters>;
  readonly channelId?: string;
}) {
  const { filters, update, channelWorks } = model;
  const t = useCollectiveText();
  const channels = [...new Set(channelWorks.map((item) => item.sourceLocation.channelId))].sort();
  const types = [
    { value: 'text/markdown', label: 'Markdown' },
    { value: 'image/', label: '图片' },
    { value: 'video/', label: '视频' },
  ]
    .map((type) => ({ ...type, count: channelWorks.filter((item) => item.mediaType.startsWith(type.value)).length }))
    .filter((type) => type.count > 0);
  return (
    <form
      className="shared-artifact-library-filters"
      aria-label={t('作品筛选')}
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="artifact-search">
        <span className="sr-only">{t('作品名称')}</span>
        <input
          type="search"
          aria-label={t('搜索作品')}
          placeholder={t('按名称找回作品')}
          value={filters.query}
          onChange={(event) => update('query', event.target.value)}
        />
      </label>
      {!channelId && (
        <label className="artifact-channel-filter">
          <span className="sr-only">{t('来自频道')}</span>
          <select
            aria-label={t('作品来源频道')}
            value={filters.channel}
            onChange={(event) => update('channel', event.target.value)}
          >
            <option value="">{t('全部频道')}</option>
            {channels.map((id) => (
              <option key={id} value={id}>
                #{id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="artifact-type-filter">
        <span className="sr-only">{t('类型')}</span>
        <select value={filters.media} onChange={(event) => update('media', event.target.value)}>
          <option value="all">
            {t('全部类型')} · {channelWorks.length}
          </option>
          {types.map((type) => (
            <option key={type.value} value={type.value}>
              {t(type.label)} · {type.count}
            </option>
          ))}
        </select>
      </label>
      <details className="artifact-sort-menu">
        <summary>{t('排列')}</summary>
        <label>
          <span className="sr-only">{t('排列')}</span>
          <select value={filters.sort} onChange={(event) => update('sort', event.target.value)}>
            <option value="recent">{t('最近记录的版本')}</option>
            <option value="name">{t('作品名称')}</option>
          </select>
        </label>
      </details>
    </form>
  );
}
