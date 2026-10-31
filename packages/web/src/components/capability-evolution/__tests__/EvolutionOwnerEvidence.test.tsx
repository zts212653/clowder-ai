import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvolutionOwnerEvidence } from '../EvolutionOwnerEvidence';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: apiFetchMock }));

const projection = {
  program: {
    programId: 'evolution-program:5073988075254b6eac9a0de0e3a27125',
    sequence: 1,
    objectRef: {
      ownerFeatureId: 'microduck-owner',
      ownerStateRef: 'simulator:walking',
      version: '183f99a40bd7308da3e848de961ed32bb02624a5',
    },
  },
};

describe('F311 owner evidence preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('labels a Microduck capture as real only after the canonical owner image loads', async () => {
    const assetUrl = `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}/adapter-media/0`;
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          manifestVersion: 'f311-microduck-show-v1',
          tier: 'B',
          phase: 'blocked',
          actionState: 'disabled',
          programRef: { ownerFeatureId: 'F311', ownerStateRef: projection.program.programId },
          programSequence: 1,
          candidates: [],
          blockers: [{ code: 'show_truth_incomplete' }],
          sceneMedia: [
            {
              sceneIndex: 0,
              source: 'real_capture',
              captureRef: {
                ownerFeatureId: 'microduck-owner',
                ownerStateRef: `capture:sha256:${'a'.repeat(64)}`,
              },
              kind: 'image',
              assetUrl,
            },
          ],
          generatedAt: '2026-09-06T00:00:00.000Z',
        }),
        { status: 200 },
      ),
    );

    await act(async () => root.render(<EvolutionOwnerEvidence projection={projection} />));
    const image = container.querySelector<HTMLImageElement>('img');
    expect(new URL(image?.getAttribute('src') ?? '', 'http://localhost').pathname).toBe(assetUrl);
    expect(container.textContent).not.toContain('真实模拟运行');

    await act(async () => image?.dispatchEvent(new Event('load')));
    expect(container.textContent).toContain('真实模拟运行');
    expect(container.textContent).toContain('不是步态鲁棒性评估');
  });

  it('renders no claim for another owner or unavailable media', async () => {
    await act(async () =>
      root.render(
        <EvolutionOwnerEvidence
          projection={{
            program: { ...projection.program, objectRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:x' } },
          }}
        />,
      ),
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');

    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'blocked' }), { status: 422 }));
    await act(async () => root.render(<EvolutionOwnerEvidence projection={projection} />));
    expect(container.textContent).not.toContain('真实模拟运行');
  });
});
