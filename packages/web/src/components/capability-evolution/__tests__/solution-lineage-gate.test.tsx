import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { SolutionLineageGate } from '../solution-gate/SolutionLineageGate';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  expect(button, label).toBeTruthy();
  await act(async () => button?.click());
}
test('reading an older scheme cannot change use, and experiments remain children of one scheme', async () => {
  await act(async () => root.render(<SolutionLineageGate />));
  await click('S2');
  expect(host.textContent).toContain('X2');
  expect(host.textContent).toContain('X3');
  await click('X3');
  expect(host.textContent).toContain('实际加载不符');
  await click('S1');
  expect(host.querySelector('[data-current-use]')?.textContent).toContain('沿用 S1');
  await click('S2');
  expect(host.querySelector('[data-experiment-detail]')?.getAttribute('data-experiment-detail')).toBe('X3');
});
test('a new ruler keeps old judgment and does not manufacture a completed experiment', async () => {
  await act(async () => root.render(<SolutionLineageGate />));
  await click('S1');
  expect(host.textContent).toContain('原判断');
  expect(host.textContent).toContain('缺少越线观测');
  await click('S3');
  expect(host.textContent).toContain('尚未运行');
  expect(host.querySelectorAll('[data-scheme-node]')).toHaveLength(3);
});
