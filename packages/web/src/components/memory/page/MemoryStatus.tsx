'use client';
import type { ConfigWarningCode, IndexStatusData } from '../IndexStatus';
import { formatMemoryDate, type MemoryRead } from './use-memory-read';

export interface MaintenanceData {
  checks: { key: string; label: string; count: number }[];
  pendingChecks: number;
  passedChecks: number;
  generatedAt: string;
}

const CONFIG_REMINDERS: Record<ConfigWarningCode, string> = {
  docs_root_suspicious: '资料库路径需要核对：有资料库的目录不存在或为空，请到设置里重新绑定或归档。',
  embedding_disabled: '语义检索没开：没有配置嵌入模型，请到设置里启动嵌入服务。',
  vectors_empty: '语义索引为空：文档已入库但没有向量，请配置嵌入服务后重建索引。',
  graph_empty: '关系图没有关系：文档已入库但尚未生成关系，请重建关系索引。',
  vec_table_missing: '段落语义索引暂不可用：向量表未就绪或嵌入服务不可用，请到设置里检查服务。',
};

function maintenanceDescription(check: MaintenanceData['checks'][number]): string {
  const count = check.count.toLocaleString();
  if (check.key === 'constitutional') return '核心规则尚未播种，需要补入资料库';
  if (check.key === 'unverified') return `${count} 篇文档没有验证记录`;
  if (check.key === 'orphan') return `${count} 条关系指向已不存在的文档`;
  return `${count} ${check.label}`;
}

export function MemoryStatusLine({
  index,
  maintenance,
}: {
  index: MemoryRead<IndexStatusData>;
  maintenance: MemoryRead<MaintenanceData>;
}) {
  const status = index.loading
    ? '正在读取索引状态…'
    : index.error
      ? '索引状态暂不可用'
      : !index.data?.healthy
        ? '索引暂不可用'
        : index.data.configWarnings.length
          ? `索引可用 · ${index.data.configWarnings.length} 项配置提醒`
          : '索引正常';
  const debt = maintenance.loading
    ? '正在读取维护状态…'
    : maintenance.error
      ? '维护状态暂不可用'
      : `${maintenance.data?.pendingChecks} 项待维护`;
  return (
    <p
      className="flex flex-wrap gap-x-2 text-compact text-cafe-muted"
      aria-live="polite"
      data-testid="memory-status-line"
    >
      <span className={index.data?.healthy && !index.error ? 'text-semantic-success' : ''}>{status}</span>
      <span>·</span>
      <span>{debt}</span>
    </p>
  );
}

export function MemoryStatusCard({
  index,
  maintenance,
}: {
  index: MemoryRead<IndexStatusData>;
  maintenance: MemoryRead<MaintenanceData>;
}) {
  const stats = index.data;
  return (
    <aside
      className="h-fit rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-5"
      aria-label="索引与维护状态"
    >
      <MemoryStatusLine index={index} maintenance={maintenance} />
      {stats?.healthy && !index.error && !index.loading && (
        <dl className="mt-4 grid grid-cols-2 gap-2 text-compact text-cafe-secondary">
          <dt>文档</dt>
          <dd>{stats.docsCount.toLocaleString()} 篇</dd>
          <dt>段落</dt>
          <dd>{stats.passagesCount.toLocaleString()} 个</dd>
          <dt>关系</dt>
          <dd>{stats.edgesCount.toLocaleString()} 条</dd>
          <dt>文档最近更新</dt>
          <dd>{formatMemoryDate(stats.lastDocumentUpdatedAt)}</dd>
        </dl>
      )}
      {stats && !index.error && stats.configWarnings.length > 0 && (
        <ul className="mt-4 space-y-2 text-compact text-cafe-secondary" aria-label="配置提醒">
          {stats.configWarnings.map((warning) => (
            <li key={warning.code}>
              {Object.hasOwn(CONFIG_REMINDERS, warning.code)
                ? CONFIG_REMINDERS[warning.code]
                : '有一项配置提醒，详情在设置里'}
            </li>
          ))}
        </ul>
      )}
      {stats && !stats.healthy && (
        <p className="mt-3 text-compact text-cafe-muted">
          {stats.reason === 'no_db'
            ? '索引库没打开'
            : stats.reason === 'query_error'
              ? '读索引时出错'
              : '索引状态暂不可用'}
        </p>
      )}
      {(index.error || (stats && !stats.healthy)) && (
        <button type="button" onClick={index.retry} className="mt-3 text-compact text-cafe-accent underline">
          重读索引状态
        </button>
      )}
      <div className="mt-5 border-t border-cafe-subtle pt-4 text-sm">
        {maintenance.data ? (
          <>
            <p className="font-medium">待维护 {maintenance.data.pendingChecks} 项</p>
            <ul className="mt-2 divide-y divide-cafe-subtle">
              {maintenance.data.checks
                .filter((c) => c.count > 0)
                .map((check) => (
                  <li key={check.key} className="py-3 text-cafe-secondary">
                    {maintenanceDescription(check)}
                  </li>
                ))}
            </ul>
            <p className="mt-2 text-compact text-cafe-muted">其余 {maintenance.data.passedChecks} 项检查通过</p>
            <p className="mt-2 text-xs text-cafe-muted">报告生成于 {formatMemoryDate(maintenance.data.generatedAt)}</p>
          </>
        ) : (
          <p className="text-cafe-muted">{maintenance.loading ? '正在读取维护状态…' : '维护状态暂不可用'}</p>
        )}
        {maintenance.error && (
          <button type="button" onClick={maintenance.retry} className="mt-3 text-compact text-cafe-accent underline">
            重读维护状态
          </button>
        )}
      </div>
      <a href="/settings" className="mt-5 block border-t border-cafe-subtle pt-4 text-compact text-cafe-accent">
        索引与服务设置 ↗
      </a>
      <p className="mt-2 text-compact text-cafe-muted">重建索引、嵌入模型和功能开关在“设置与管理”里</p>
    </aside>
  );
}
