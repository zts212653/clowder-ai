import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityEvolutionWorkspace } from '../CapabilityEvolutionWorkspace';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));

function unnamed(stage: 'constituting' | 'instrumenting', id: string, title?: string): EvolutionProgramProjection {
  const base = programFixture(stage);
  const programId = `evolution-program:${id.repeat(32)}`;
  return {
    ...base,
    program: { ...base.program, programId, displayName: undefined, currentAssetVersionRefs: [] },
    cycles: base.cycles.map((cycle) => ({ ...cycle, programId })),
    ...(title ? { origin: { threadId: `thread-${id}`, title } } : {}),
    blockers:
      stage === 'constituting'
        ? [{ code: 'goal_certificate_missing', ownerFeatureId: 'F311', message: 'goal missing' }]
        : [],
    observation: {
      status: 'insufficient',
      connectedEyes: [],
      gaps: [{ code: 'trajectory_ref_missing', ownerFeatureId: 'F299', message: 'trajectory missing' }],
    },
  };
}

describe('F311 real unnamed project readability', () => {
  let host: HTMLDivElement;
  let root: Root;
  let programs: EvolutionProgramProjection[];
  const open = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useEvolutionReading.setState({ workspaceProgramIds: {}, programs: {} });
    programs = [unnamed('instrumenting', 'a', '让审阅更贴近原始需求'), unnamed('constituting', 'b', '路演表达实验')];
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path.includes('/asset-review')) return new Response('{}', { status: 422 });
      if (path === '/api/capability-evolution/programs') return Response.json({ programs });
      const projection = programs.find(
        (item) => path === `/api/capability-evolution/programs/${encodeURIComponent(item.program.programId)}`,
      );
      return projection ? Response.json(projection) : new Response('{}', { status: 404 });
    });
    open.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() {
    await act(async () => root.render(<CapabilityEvolutionWorkspace targetThreadId={null} onOpenProgram={open} />));
  }
  it('distinguishes two opaque projects by verified conversations and current-stage work', async () => {
    await render();
    const rows = host.querySelectorAll('[data-testid^="capability-evolution-program-evolution-program:"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('来自「让审阅更贴近原始需求」');
    expect(rows[0]?.textContent).toContain('准备评估');
    expect(rows[0]?.textContent).toContain('补充真实任务的执行记录');
    expect(rows[1]?.textContent).toContain('来自「路演表达实验」');
    expect(rows[1]?.textContent).toContain('准备目标');
    expect(rows[1]?.textContent).toContain('明确要改进什么');
    expect(rows[1]?.textContent).not.toContain('运行轨迹');
    expect(host.textContent).not.toMatch(/aaaaaaaa|bbbbbbbb|项评估条件待完成/);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/thread/thread-a');
    await act(async () => (rows[0] as HTMLButtonElement).click());
    const review = [...host.querySelectorAll('button')].find((button) => button.textContent === '展开阅读 →');
    await act(async () => review?.click());
    expect(open).toHaveBeenCalledWith(programs[0]?.program.programId, undefined, programs[0]?.origin);
  });
  it('removes revoked source context on a fresh read and offers explicit naming instead of a fake title', async () => {
    await render();
    programs = programs.map((projection) => ({ ...projection, origin: undefined }));
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === '刷新')?.click(),
    );
    expect(host.textContent).not.toContain('让审阅更贴近原始需求');
    expect(host.textContent).toContain('未命名项目');
    expect(host.textContent).toContain('尚未保存目标名称');
    expect(host.querySelector('a')).toBeNull();
  });
});
