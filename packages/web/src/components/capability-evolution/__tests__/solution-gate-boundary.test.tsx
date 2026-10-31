import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { EvolutionProgramSurface } from '../solution-gate/SolutionGateHost';
import { SOLUTION_PREVIEW_ID } from '../solution-gate/solution-example';

vi.mock('../EvolutionProgramSurface', () => ({
  EvolutionProgramSurface: ({ programId }: { programId: string }) => <p data-product-id={programId}>实际项目读面</p>,
}));
vi.mock('../solution-gate/duck-demo/DuckEvolutionDemo', () => ({ DuckEvolutionDemo: () => <p>旧鸭鸭示意</p> }));
vi.mock('../solution-gate/SolutionLineageGate', () => ({ SolutionLineageGate: () => <p>旧谱系示意</p> }));

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

test.each([
  ['production', SOLUTION_PREVIEW_ID, false],
  ['development', 'evolution-program:real', false],
  ['development', SOLUTION_PREVIEW_ID, true],
] as const)('mock marker is scoped to development and exact fixture identity: %s %s', async (environment, id, mock) => {
  vi.stubEnv('NODE_ENV', environment);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', '/?mockExploration=1&solutionGate=1&duckDemo=1');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<EvolutionProgramSurface programId={id} />));
    expect(host.querySelector('[data-product-id]')?.getAttribute('data-product-id')).toBe(id);
    expect(host.textContent).not.toContain('旧鸭鸭示意');
    expect(host.textContent).not.toContain('旧谱系示意');
    expect(Boolean(host.querySelector('[data-testid="mock-exploration-host"]'))).toBe(mock);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
