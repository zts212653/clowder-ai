import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityEvolutionWorkspace } from '../CapabilityEvolutionWorkspace';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { useEvolutionPrograms } from '../evolution-program-resource';
import { useEvolutionReading } from '../evolution-reading-state';
import { EvolutionPreparationWorkspace } from '../preparation/EvolutionPreparationWorkspace';
import { PROGRAM_ID, programFixture } from './evolution-fixtures';
import { evolutionPreparationFixture } from './evolution-preparation-fixtures';

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function ListRead() {
  const { programs, reload } = useEvolutionPrograms();
  return (
    <>
      <button type="button" onClick={() => void reload()}>
        刷新列表
      </button>
      <output data-list-count>{programs.length}</output>
    </>
  );
}

function DetailRead() {
  const { projection, reload } = useEvolutionPrograms(PROGRAM_ID);
  return (
    <>
      <button type="button" onClick={() => void reload()}>
        刷新详情
      </button>
      {projection && <EvolutionPreparationWorkspace projection={projection} />}
    </>
  );
}

describe('F311 list and detail read scopes', () => {
  let host: HTMLDivElement;
  let root: Root;
  let summary: EvolutionProgramProjection;
  let detail: EvolutionProgramProjection;
  let detailStatus: number;
  let holdDetail: boolean;
  let resolveDetail: ((response: Response) => void) | undefined;
  const detailPath = `/api/capability-evolution/programs/${encodeURIComponent(PROGRAM_ID)}`;
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    summary = programFixture('instrumenting', 2);
    detail = { ...summary, preparation: evolutionPreparationFixture() };
    detailStatus = 200;
    holdDetail = false;
    resolveDetail = undefined;
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/capability-evolution/programs') return Promise.resolve(response({ programs: [summary] }));
      if (path === detailPath) {
        if (holdDetail)
          return new Promise<Response>((resolve) => {
            resolveDetail = resolve;
          });
        return Promise.resolve(response(detail, detailStatus));
      }
      return Promise.resolve(response({}, 404));
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      resolveDetail?.(response(detail));
    });
    host.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(view: React.ReactNode) {
    await act(async () => root.render(view));
  }

  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    if (!button) throw new Error(`missing button: ${label}`);
    await act(async () => button.click());
  }

  it('keeps preparation visible while summary polling finishes before the same-sequence detail read', async () => {
    await render(
      <>
        <ListRead />
        <DetailRead />
      </>,
    );
    expect(host.textContent).toContain('项目数据与反馈');

    for (let poll = 0; poll < 3; poll += 1) {
      holdDetail = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(resolveDetail).toBeTypeOf('function');
      expect(host.textContent).toContain('项目数据与反馈');
      expect(host.textContent).not.toContain('准备记录尚未提供');
      await act(async () => {
        resolveDetail?.(response(detail));
      });
    }
  });

  it('reads exact preparation when opening a Program directly from the workspace list', async () => {
    await render(<CapabilityEvolutionWorkspace targetThreadId="thread-read-scope" onOpenProgram={vi.fn()} />);
    await click('查看进展');
    expect(apiFetchMock.mock.calls.some(([path]) => path === detailPath)).toBe(true);
    expect(host.textContent).toContain('项目数据与反馈');
    expect(host.textContent).not.toContain('准备记录尚未提供');
  });

  it('does not preserve preparation after an authoritative detail response stops providing it', async () => {
    await render(
      <>
        <ListRead />
        <DetailRead />
      </>,
    );
    expect(host.textContent).toContain('项目数据与反馈');
    detail = summary;
    await click('刷新详情');
    expect(host.textContent).not.toContain('项目数据与反馈');
    expect(host.textContent).toContain('准备记录尚未提供');
  });

  it('removes both list and detail content when the exact Program no longer exists', async () => {
    await render(
      <>
        <ListRead />
        <DetailRead />
      </>,
    );
    detailStatus = 404;
    await click('刷新详情');
    expect(host.textContent).not.toContain('项目数据与反馈');
    expect(host.querySelector('[data-list-count]')?.textContent).toBe('0');
  });

  it('clears both read scopes on authorization loss', async () => {
    await render(
      <>
        <ListRead />
        <DetailRead />
      </>,
    );
    detailStatus = 403;
    await click('刷新详情');
    expect(host.textContent).not.toContain('项目数据与反馈');
    expect(host.querySelector('[data-list-count]')?.textContent).toBe('0');
  });
});
