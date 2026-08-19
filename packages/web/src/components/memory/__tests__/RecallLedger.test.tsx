/**
 * F263 B.5 Task 4 + Phase C AC-C2: RecallLedger component tests
 *
 * Coverage: loading / empty / full / error-retry / pull-only / push-only partial
 * + three-axis section: no-data / measured / lower-bound / no total score
 * Matches operator-approved wireframe v2 + Phase C Design Gate.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock apiFetch before importing the component
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

// Import AFTER mock is set up
const { RecallLedger } = await import('../RecallLedger');

function makeLedgerResponse(
  days: number,
  rows: Array<{ source: string; surface: string; presented: number; inspected: number; used: number }>,
) {
  return {
    ok: true,
    json: async () => ({
      days,
      from: Date.now() - days * 86400000,
      to: Date.now(),
      rows,
    }),
  };
}

describe('RecallLedger — state matrix', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows loading state while fetching', async () => {
    // Never resolve — stays loading
    mockApiFetch.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(<RecallLedger />);
    });

    expect(container.querySelector('[data-testid="recall-ledger-loading"]')).not.toBeNull();
    expect(container.textContent).toContain('加载中');
  });

  it('shows empty state when all windows return zero-presented rows', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      return Promise.resolve(makeLedgerResponse(days, []));
    });

    await act(async () => {
      root.render(<RecallLedger />);
    });
    // Let promises resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="recall-ledger-empty"]')).not.toBeNull();
    expect(container.textContent).toContain('还没有 recall 记录');
  });

  it('shows full state with comparison table and both funnel bars', async () => {
    const rows = [
      { source: 'pull', surface: 'search_evidence', presented: 10, inspected: 8, used: 5 },
      { source: 'push', surface: 'session_bootstrap', presented: 6, inspected: 4, used: 3 },
    ];
    mockApiFetch.mockImplementation((url: string) => {
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      return Promise.resolve(makeLedgerResponse(days, rows));
    });

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = container.textContent ?? '';
    // Comparison table headers
    expect(text).toContain('7天');
    expect(text).toContain('14天');
    expect(text).toContain('30天');
    // Metric labels
    expect(text).toContain('投喂');
    expect(text).toContain('检视');
    expect(text).toContain('使用');
    expect(text).toContain('使用率');
    // Funnel bars — both sources present
    expect(text).toContain('Pull 使用率');
    expect(text).toContain('Push 使用率');
    // Data values
    expect(text).toContain('16'); // 10+6 presented total
    expect(container.querySelector('[data-testid="recall-ledger-funnels"]')).not.toBeNull();
  });

  it('uses four distinct designed SVG icons without raw emoji glyphs', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(makeLedgerAndAxisMock(rows));

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const icons = Array.from(container.querySelectorAll('svg[data-recall-ledger-icon]'));
    expect(icons).toHaveLength(4);
    expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(4);
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(container.textContent).not.toMatch(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u);
  });

  it('shows error state with retry button', async () => {
    mockApiFetch.mockRejectedValue(new Error('500'));

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="recall-ledger-error"]')).not.toBeNull();
    expect(container.textContent).toContain('加载失败');
    expect(container.textContent).toContain('重试');
  });

  it('retry button re-fetches data', async () => {
    // First call fails
    mockApiFetch.mockRejectedValueOnce(new Error('500'));

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="recall-ledger-error"]')).not.toBeNull();

    // Set up success for retry
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation((url: string) => {
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      return Promise.resolve(makeLedgerResponse(days, rows));
    });

    // Click retry
    await act(async () => {
      const retryBtn = container.querySelector('[data-testid="recall-ledger-error"] button');
      retryBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="recall-ledger-error"]')).toBeNull();
    expect(container.textContent).toContain('投喂');
  });

  it('pull-only partial: shows Pull bar, omits Push bar', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 8, inspected: 6, used: 4 }];
    mockApiFetch.mockImplementation((url: string) => {
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      return Promise.resolve(makeLedgerResponse(days, rows));
    });

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Pull 使用率');
    expect(text).not.toContain('Push 使用率');
  });

  it('push-only partial: shows Push bar, omits Pull bar', async () => {
    const rows = [{ source: 'push', surface: 'session_bootstrap', presented: 4, inspected: 2, used: 1 }];
    mockApiFetch.mockImplementation((url: string) => {
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      return Promise.resolve(makeLedgerResponse(days, rows));
    });

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Push 使用率');
    expect(text).not.toContain('Pull 使用率');
  });
});

// ── F263 Phase C: Three-axis section tests ─────────────────────────

function makeThreeAxisResponse(days: number, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      days,
      from: Date.now() - days * 86400000,
      to: Date.now(),
      harmfulConsumption: { value: 0, maturity: 'no-data', reason: 'no data' },
      unmetDemandLowerBound: { value: 0, maturity: 'no-data', reason: 'no data' },
      attentionCost: { value: 0, maturity: 'no-data', reason: 'no data' },
      ...overrides,
    }),
  };
}

function makeLedgerAndAxisMock(
  rows: Array<{ source: string; surface: string; presented: number; inspected: number; used: number }>,
  axisOverrides: Record<string, unknown> = {},
) {
  return (url: string) => {
    if (url.includes('three-axis')) {
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      return Promise.resolve(makeThreeAxisResponse(days, axisOverrides));
    }
    const match = url.match(/days=(\d+)/);
    const days = match ? Number(match[1]) : 7;
    return Promise.resolve(makeLedgerResponse(days, rows));
  };
}

describe('RecallLedger — F263 Phase C three-axis section', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders three-axis section with no-data maturity labels', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(makeLedgerAndAxisMock(rows));

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const section = container.querySelector('[data-testid="three-axis-section"]');
    expect(section).not.toBeNull();

    const text = container.textContent ?? '';
    expect(text).toContain('三轴观测');
    expect(text).toContain('有害消费');
    expect(text).toContain('错失需求');
    expect(text).toContain('注意力成本');
    // Maturity labels
    expect(text).toContain('无数据');
  });

  it('renders measured values when harmful consumption exists', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(
      makeLedgerAndAxisMock(rows, {
        harmfulConsumption: { value: 3, maturity: 'measured', reason: null },
      }),
    );

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = container.textContent ?? '';
    expect(text).toContain('实测');
  });

  it('renders lower-bound label for unmet demand', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(
      makeLedgerAndAxisMock(rows, {
        unmetDemandLowerBound: { value: 2, maturity: 'lower-bound', reason: '下界' },
      }),
    );

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = container.textContent ?? '';
    expect(text).toContain('下界');
  });

  it('MUST NOT render any total score (禁总分 snapshot test)', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(
      makeLedgerAndAxisMock(rows, {
        harmfulConsumption: { value: 1, maturity: 'measured', reason: null },
        unmetDemandLowerBound: { value: 2, maturity: 'lower-bound', reason: '下界' },
        attentionCost: { value: 3, maturity: 'measured', reason: null },
      }),
    );

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = container.textContent ?? '';
    // No total score, no overall, no aggregate
    expect(text).not.toContain('总分');
    expect(text).not.toContain('总得分');
    expect(text).not.toContain('overall');
    expect(text).not.toContain('total score');
  });

  it('shows three-axis table with 7d/14d/30d columns', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(makeLedgerAndAxisMock(rows));

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const table = container.querySelector('[data-testid="three-axis-table"]');
    expect(table).not.toBeNull();
    const headers = table?.querySelectorAll('th');
    const headerTexts = Array.from(headers ?? []).map((h) => h.textContent);
    expect(headerTexts).toContain('7天');
    expect(headerTexts).toContain('14天');
    expect(headerTexts).toContain('30天');
  });

  it('gracefully handles three-axis fetch failure', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('three-axis')) return Promise.resolve({ ok: false, status: 500 });
      const match = url.match(/days=(\d+)/);
      const days = match ? Number(match[1]) : 7;
      const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
      return Promise.resolve(makeLedgerResponse(days, rows));
    });

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Consumption table still works
    expect(container.textContent).toContain('投喂');
    // Three-axis section absent (graceful degradation)
    expect(container.querySelector('[data-testid="three-axis-section"]')).toBeNull();
  });

  it('FN reading annotated as lower-bound, not fake 0', async () => {
    const rows = [{ source: 'pull', surface: 'search_evidence', presented: 5, inspected: 3, used: 2 }];
    mockApiFetch.mockImplementation(
      makeLedgerAndAxisMock(rows, {
        unmetDemandLowerBound: { value: 0, maturity: 'no-data', reason: '该窗口无 true-zero 观测。' },
      }),
    );

    await act(async () => {
      root.render(<RecallLedger />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // When value is 0 with no-data maturity, show "—" not "0"
    const values = container.querySelectorAll('[data-testid="axis-value"]');
    // At least one should show "—" (no-data shows dash, not fake 0)
    const dashValues = Array.from(values).filter((v) => v.textContent === '—');
    expect(dashValues.length).toBeGreaterThan(0);
  });
});
