/**
 * Tests for the warmup resume button in IndexStatus.
 *
 * P1 coverage: button click triggers POST /api/evidence/warmup
 * P2 coverage: HTTP error surfaces error message in UI
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock apiFetch before importing the component
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// RebuildButton is a child — stub it out to reduce noise
vi.mock('@/components/memory/RebuildButton', () => ({
  RebuildButton: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import after mocks
const { IndexStatus } = await import('@/components/memory/IndexStatus');

/** Helper: build a mock Response with JSON body */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
    statusText: 'OK',
  } as Response;
}

/** Status response that shows warmup in progress (vectors < passages) */
const warmingUpStatus = {
  backend: 'sqlite',
  healthy: true,
  docs_count: 10,
  passages_count: 100,
  passage_vectors_count: 22,
  passage_vectors_supported: true,
  vectors_count: 10,
};

const envSummary = { variables: [] };

describe('warmup resume button', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    root.unmount();
    document.body.removeChild(container);
  });

  /** Render IndexStatus and wait for initial fetch to settle */
  async function renderAndWait() {
    // Initial mount triggers fetchAll: /api/evidence/status + /api/config/env-summary
    mockApiFetch.mockResolvedValueOnce(mockResponse(warmingUpStatus)).mockResolvedValueOnce(mockResponse(envSummary));

    await act(async () => {
      root.render(createElement(IndexStatus));
    });

    // Let useEffect + fetchAll settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  it('sends POST /api/evidence/warmup on click', async () => {
    await renderAndWait();

    const btn = container.querySelector('[data-testid="warmup-resume-button"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('继续暖机');

    // The warmup POST + the fetchAll refresh after it
    mockApiFetch
      .mockResolvedValueOnce(mockResponse({ ok: true })) // POST /api/evidence/warmup
      .mockResolvedValueOnce(mockResponse(warmingUpStatus)) // fetchAll status
      .mockResolvedValueOnce(mockResponse(envSummary)); // fetchAll env

    await act(async () => {
      btn.click();
    });

    // Wait for async triggerWarmup to finish
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Find the warmup call (not the initial fetchAll calls)
    const warmupCall = mockApiFetch.mock.calls.find((args: unknown[]) => args[0] === '/api/evidence/warmup');
    expect(warmupCall).toBeTruthy();
    expect((warmupCall?.[1] as { method: string }).method).toBe('POST');
  });

  it('surfaces error when warmup POST returns 403', async () => {
    await renderAndWait();

    const btn = container.querySelector('[data-testid="warmup-resume-button"]') as HTMLButtonElement;

    // Warmup POST returns 403, then fetchAll refresh
    mockApiFetch
      .mockResolvedValueOnce(mockResponse({ error: 'Forbidden: localhost only' }, 403))
      .mockResolvedValueOnce(mockResponse(warmingUpStatus))
      .mockResolvedValueOnce(mockResponse(envSummary));

    await act(async () => {
      btn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const errorEl = container.querySelector('[data-testid="warmup-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl?.textContent).toBe('Forbidden: localhost only');
  });

  it('surfaces error when warmup POST returns 503', async () => {
    await renderAndWait();

    const btn = container.querySelector('[data-testid="warmup-resume-button"]') as HTMLButtonElement;

    mockApiFetch
      .mockResolvedValueOnce(mockResponse({ error: 'warmup not available' }, 503))
      .mockResolvedValueOnce(mockResponse(warmingUpStatus))
      .mockResolvedValueOnce(mockResponse(envSummary));

    await act(async () => {
      btn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const errorEl = container.querySelector('[data-testid="warmup-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl?.textContent).toBe('warmup not available');
  });

  it('shows network error when fetch throws', async () => {
    await renderAndWait();

    const btn = container.querySelector('[data-testid="warmup-resume-button"]') as HTMLButtonElement;

    mockApiFetch.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      btn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const errorEl = container.querySelector('[data-testid="warmup-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl?.textContent).toBe('网络错误');
  });
});
