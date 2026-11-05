import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { DEMO_DELIVERABLE_HTML } from '../../onboarding-demo/demo-deliverable';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'dangerously' }) => { window: Window & typeof globalThis };
};

function deliver(dom: { window: Window & typeof globalThis }, stage: string) {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      source: dom.window.parent,
      data: { type: 'clowder-onboarding-stage', version: 1, stage },
    }),
  );
}

it.each([
  ['initial', 'review'],
  ['review', 'final'],
])('keeps keyboard focus as preview advances from %s to %s', (from, to) => {
  const dom = new JSDOM(DEMO_DELIVERABLE_HTML, { runScripts: 'dangerously' });
  try {
    const page = dom.window.document;
    deliver(dom, from);
    page.querySelector<HTMLInputElement>('[data-task-id="2"]')?.focus();
    deliver(dom, to);
    expect(page.activeElement?.getAttribute('data-task-id')).toBe('2');
    (page.activeElement as HTMLInputElement).click();
    expect((page.activeElement as HTMLInputElement).checked).toBe(true);
    const input = page.querySelector<HTMLInputElement>('#new-task')!;
    input.focus();
    deliver(dom, to);
    expect(page.activeElement).toBe(input);
  } finally {
    dom.window.close();
  }
});

it('progressively builds the same document and retains tasks through review fixes', () => {
  const dom = new JSDOM(DEMO_DELIVERABLE_HTML, { runScripts: 'dangerously' });
  try {
    const page = dom.window.document;
    const input = page.querySelector<HTMLInputElement>('#new-task')!;
    expect(page.body.dataset.stage).toBe('waiting');
    deliver(dom, 'design');
    expect(input.disabled).toBe(true);
    deliver(dom, 'initial');
    input.value = '预览中添加的任务';
    page.querySelector<HTMLButtonElement>('#add-task')?.click();
    deliver(dom, 'review');
    expect(page.querySelector('#review-notes')?.textContent).toContain('空白输入');
    deliver(dom, 'final');
    expect(page.querySelector('#new-task')).toBe(input);
    expect(page.querySelector('#tasks')?.textContent).toContain('预览中添加的任务');
    expect(page.body.dataset.stage).toBe('final');
    deliver(dom, 'untrusted-stage');
    expect(page.body.dataset.stage).toBe('final');
  } finally {
    dom.window.close();
  }
});

it('delivers the promised add, complete, filter and reviewed empty-state interactions', () => {
  const dom = new JSDOM(DEMO_DELIVERABLE_HTML, { runScripts: 'dangerously' });
  deliver(dom, 'final');
  try {
    const page = dom.window.document;
    const input = page.querySelector<HTMLInputElement>('#new-task');
    const add = page.querySelector<HTMLButtonElement>('#add-task');
    if (!input || !add) throw new Error('Missing task form');
    input.value = '   ';
    add.click();
    expect(page.querySelector('#feedback')?.textContent).toContain('先写下一件小事');
    input.value = '  用户自己的小目标  ';
    add.click();
    expect(page.querySelector('#tasks')?.textContent).toContain('用户自己的小目标');
    page.querySelector<HTMLButtonElement>('[data-filter="open"]')?.click();
    while (page.querySelector<HTMLInputElement>('input[type="checkbox"]')) {
      page.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    }
    expect(page.querySelector<HTMLElement>('#empty')?.hidden).toBe(false);
    expect(page.querySelector('#empty')?.textContent).toContain('今天的任务都完成了');
    page.querySelector<HTMLButtonElement>('[data-filter="done"]')?.click();
    expect(page.querySelectorAll('#tasks li')).toHaveLength(4);
    expect(page.querySelector('#count')?.textContent).toBe('4 / 4 已完成');
    input.value = '<img src=x onerror=alert(1)>';
    add.click();
    expect(page.querySelector('#feedback')?.textContent).toContain('切换到');
    page.querySelector<HTMLButtonElement>('[data-filter="all"]')?.click();
    expect(page.querySelector('#tasks img')).toBeNull();
    expect(page.querySelector('#tasks')?.textContent).toContain('<img src=x onerror=alert(1)>');
  } finally {
    dom.window.close();
  }
});

it('preserves keyboard focus on toggle, then moves to a neighbour or the active filter when removed', () => {
  const dom = new JSDOM(DEMO_DELIVERABLE_HTML, { runScripts: 'dangerously' });
  deliver(dom, 'final');
  try {
    const page = dom.window.document;
    const task = page.querySelector<HTMLInputElement>('#tasks input');
    task?.focus();
    task?.click();
    expect(page.activeElement?.closest('label')?.textContent).toContain('看看三位伙伴如何协作');
    page.querySelector<HTMLButtonElement>('[data-filter="open"]')?.click();
    for (const expected of ['试着添加一件自己的小事', '创建自己的猫猫团队']) {
      const first = page.querySelector<HTMLInputElement>('#tasks input');
      first?.focus();
      first?.click();
      expect(page.activeElement?.closest('label')?.textContent).toContain(expected);
    }
    const last = page.querySelector<HTMLInputElement>('#tasks input');
    last?.focus();
    last?.click();
    expect(page.activeElement?.getAttribute('data-filter')).toBe('open');
  } finally {
    dom.window.close();
  }
});
