import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfigWarningCode, parseIndexStatus } from '../../IndexStatus';
import { type MaintenanceData, MemoryStatusCard } from '../MemoryStatus';
import { formatMemoryDate, type MemoryRead } from '../use-memory-read';

let container: HTMLDivElement;
let root: Root;
const read = <T,>(data: T | null, error = false): MemoryRead<T> => ({ data, loading: false, error, retry: vi.fn() });
const maintenanceData: MaintenanceData = {
  checks: [
    { key: 'unverified', label: '没有验证记录的文档', count: 2640 },
    { key: 'orphan', label: '指向不存在文档的关系', count: 65 },
  ],
  pendingChecks: 2,
  passedChecks: 4,
  generatedAt: '2026-10-03T00:00:00Z',
};
const maintenance = read(maintenanceData);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
const render = async (codes: ConfigWarningCode[] = [], failedMaintenance = false) => {
  await act(() =>
    root.render(
      <MemoryStatusCard
        index={read(
          parseIndexStatus({
            backend: 'sqlite',
            healthy: true,
            last_rebuild_at: '2026-09-01T00:00:00Z',
            last_document_updated_at: '2026-10-03T00:17:41Z',
            functionalStatus: codes.length ? 'degraded' : 'ok',
            configWarnings: codes.map((code) => ({
              code,
              message: 'internal-id: raw English',
              suggestedAction: 'raw',
            })),
          }),
        )}
        maintenance={failedMaintenance ? read<MaintenanceData>(null, true) : maintenance}
      />,
    ),
  );
};
describe('owner memory status', () => {
  it('uses the explicit document clock rather than the legacy rebuild field', async () => {
    await render();
    const clock = [...container.querySelectorAll('dt')].find((item) => item.textContent === '文档最近更新');
    expect(clock?.nextElementSibling?.textContent).toBe(formatMemoryDate('2026-10-03T00:17:41Z'));
  });
  for (const [reason, text] of [
    ['no_db', '索引库没打开'],
    ['query_error', '读索引时出错'],
  ]) {
    it(`unhealthy ${reason} does not claim zero counts or a missing document clock`, async () => {
      await act(() =>
        root.render(
          <MemoryStatusCard
            index={read(parseIndexStatus({ backend: 'sqlite', healthy: false, reason }))}
            maintenance={maintenance}
          />,
        ),
      );
      expect(container.querySelector('dl')).toBeNull();
      expect(container.textContent).toContain(text);
      expect(container.textContent).not.toContain('时间没有记录下来');
      expect([...container.querySelectorAll('button')].some((b) => b.textContent === '重读索引状态')).toBe(true);
    });
  }
  for (const code of ['future_code', 'constructor'])
    it(`shows a useful reminder for an unknown backend code (${code}) without exposing its raw message`, async () => {
      await render([code as ConfigWarningCode]);
      expect(container.textContent).toContain('索引可用 · 1 项配置提醒');
      expect(container.textContent).toContain('有一项配置提醒，详情在设置里');
      expect(container.textContent).not.toContain('internal-id');
    });
  it('describes a missing core-rule seed as an action rather than a count', async () => {
    await act(() =>
      root.render(
        <MemoryStatusCard
          index={read(parseIndexStatus({ backend: 'sqlite', healthy: true }))}
          maintenance={read({
            ...maintenanceData,
            checks: [{ key: 'constitutional', label: '核心规则播种', count: 1 }],
          })}
        />,
      ),
    );
    expect(container.textContent).toContain('核心规则尚未播种，需要补入资料库');
    expect(container.textContent).not.toContain('1 核心规则播种');
  });
  it('does not hide an available index clock behind an unavailable maintenance read', async () => {
    await render([], true);
    expect(container.textContent).toContain(formatMemoryDate('2026-10-03T00:17:41Z'));
    expect(container.textContent).toContain('维护状态暂不可用');
  });
  it('counts configuration reminders and translates every producer code without leaking its raw message', async () => {
    await render(['docs_root_suspicious', 'embedding_disabled', 'vectors_empty', 'graph_empty', 'vec_table_missing']);
    expect(container.textContent).toContain('索引可用 · 5 项配置提醒');
    for (const text of [
      '资料库路径需要核对',
      '语义检索没开：没有配置嵌入模型',
      '语义索引为空',
      '关系图没有关系',
      '段落语义索引暂不可用',
    ]) {
      expect(container.textContent).toContain(text);
    }
    expect(container.textContent).not.toContain('internal-id');
    expect(container.textContent).not.toContain('raw English');
    expect(container.textContent).not.toContain('部分能力受限');
  });
  it('states the affected documents and relationships in owner language', async () => {
    await render();
    expect(container.textContent).toContain('2,640 篇文档没有验证记录');
    expect(container.textContent).toContain('65 条关系指向已不存在的文档');
  });
});
