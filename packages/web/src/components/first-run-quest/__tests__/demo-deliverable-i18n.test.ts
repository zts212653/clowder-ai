import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { DEMO_DELIVERABLE_HTML } from '../../onboarding-demo/demo-deliverable';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'dangerously' }) => { window: Window & typeof globalThis };
};

it('localizes the real result and feedback while preserving authored tasks, completion, focus and filters', () => {
  const dom = new JSDOM(DEMO_DELIVERABLE_HTML, { runScripts: 'dangerously' });
  const language = (value: 'en' | 'zh') =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        source: dom.window.parent,
        data: { type: 'clowder-onboarding-stage', version: 1, stage: 'final', language: value },
      }),
    );
  try {
    const page = dom.window.document;
    language('en');
    expect(page.documentElement.lang).toBe('en');
    const visibleContent = page.body.cloneNode(true) as HTMLElement;
    visibleContent.querySelectorAll('script, style').forEach((node) => node.remove());
    expect(visibleContent.textContent).not.toMatch(/\p{Script=Han}/u);
    const input = page.querySelector<HTMLInputElement>('#new-task');
    if (!input) throw new Error('Missing task input');
    page.querySelector<HTMLButtonElement>('#add-task')?.click();
    expect(page.querySelector('#feedback')?.textContent).toBe('Write a small task first, then choose Add.');
    input.value = '我的任务 <img src=x onerror=alert(1)>';
    page.querySelector<HTMLButtonElement>('#add-task')?.click();
    page.querySelector<HTMLButtonElement>('[data-filter="open"]')?.click();
    input.focus();
    language('zh');
    language('en');
    expect(page.activeElement).toBe(input);
    expect(page.querySelector('[data-filter="open"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.querySelector('#tasks')?.textContent).toContain('我的任务 <img src=x onerror=alert(1)>');
    expect(page.querySelector('#tasks img')).toBeNull();
    while (page.querySelector<HTMLInputElement>('#tasks input'))
      page.querySelector<HTMLInputElement>('#tasks input')?.click();
    expect(page.querySelector('#empty')?.textContent).toBe('All done for today. Nice work!');
    expect(page.querySelector('#count')?.textContent).toBe('4 / 4 completed');
  } finally {
    dom.window.close();
  }
});
