import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { F305ApprovalDesignGatePreview } from '../preview';

function visibleText(container: HTMLElement): string {
  const visible = container.cloneNode(true) as HTMLElement;
  for (const details of visible.querySelectorAll('details:not([open])')) details.remove();
  return visible.textContent ?? '';
}

describe('F305 approval design gate preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('starts from one visible decision while edit and source detail stay folded', async () => {
    await act(async () => root.render(<F305ApprovalDesignGatePreview />));

    expect(container.querySelector('[data-testid="f305-candidate-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f305-primary-action"]')?.textContent).toContain('确认并开始整理');
    expect(container.textContent).toContain('为什么需要我');
    expect(container.textContent).toContain('猫猫建议');
    expect(container.querySelector('[data-testid="meeting-speakers"]')).toBeNull();
    const sourceDetails = container.querySelector<HTMLDetailsElement>('[data-testid="f305-source-details"]');
    expect(sourceDetails?.open).toBe(false);
    expect(sourceDetails?.textContent).toContain('feishu://meeting-artifacts');
    expect(visibleText(container)).not.toContain('rev 1');

    await act(async () => {
      (container.querySelector('[data-testid="f305-edit-toggle"]') as HTMLButtonElement).click();
    });

    expect(container.querySelector('[data-testid="meeting-speakers"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="meeting-context"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="meeting-destination"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="meeting-output-minutes"]')).not.toBeNull();
  });

  it('uses a believable user scenario instead of design or implementation vocabulary', async () => {
    await act(async () => root.render(<F305ApprovalDesignGatePreview />));

    const visibleCopy = visibleText(container);
    expect(visibleCopy).toContain('模型质量周会');
    expect(visibleCopy).toContain('请确认要生成的资料和保存位置');
    expect(visibleCopy).not.toMatch(/F305|Design Gate|Needs Me|Meeting|canonical|repair/i);
  });

  it('keeps current baseline available without changing the fixture', async () => {
    await act(async () => root.render(<F305ApprovalDesignGatePreview />));
    await act(async () => {
      (container.querySelector('[data-testid="f305-mode-current"]') as HTMLButtonElement).click();
    });

    expect(container.querySelector('[data-testid="f305-current-card"]')).not.toBeNull();
    expect(container.textContent).toContain('整理会议：模型质量周会');
    expect(container.textContent).toContain('feishu://meeting-artifacts/minute/obcnj98z126oab1n999i9xg2');
    expect(container.textContent).toContain('rev 1');
    expect(container.querySelector('[data-testid="meeting-speakers"]')).not.toBeNull();
  });

  it('surfaces repair in the same card and preserves the candidate hierarchy at narrow width', async () => {
    await act(async () => root.render(<F305ApprovalDesignGatePreview />));
    await act(async () => {
      (container.querySelector('[data-testid="f305-state-repair"]') as HTMLButtonElement).click();
      (container.querySelector('[data-testid="f305-width-narrow"]') as HTMLButtonElement).click();
    });

    expect(container.querySelector('[data-testid="f305-repair"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f305-repair-action"]')?.textContent).toContain('重新连接飞书');
    expect(container.querySelector('[data-testid="f305-shell"]')?.getAttribute('data-width')).toBe('narrow');
    expect(container.querySelector('[data-testid="f305-candidate-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f305-primary-action"]')).toBeNull();
  });
});
