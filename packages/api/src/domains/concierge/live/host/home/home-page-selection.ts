import type { HomeActionNotice, HomeActionRequest } from '../../../action/HomeActionController.js';
import type { createJevPageSelector } from '../../../action/jev/JevPageSelector.js';
import type { HomeHubPage, HomeHubPages } from './home-hub-pages.js';

type Resolution = { page: HomeHubPage } | HomeActionNotice;
const signature = (pages: readonly HomeHubPage[]) => JSON.stringify(pages.map(({ id, label }) => [id, label]));

/** One page per current request. A clarification never inherits a renumbered page list. */
export class HomePageSelection {
  private readonly selected = new WeakMap<HomeActionRequest, HomeHubPage>();
  private offered?: { signature: string; expiresAt: number };
  constructor(
    private readonly pages: HomeHubPages,
    private readonly selector: ReturnType<typeof createJevPageSelector>,
  ) {}

  private ask(pages: readonly HomeHubPage[], changed = false): HomeActionNotice {
    this.offered = { signature: signature(pages), expiresAt: Date.now() + 60_000 };
    return {
      status: 'ask',
      reason: `${changed ? '页面列表已变化或选择已过期。' : ''}请选择一个家内页面，并说明要在该页执行的操作：${pages.map((page) => page.label).join('；')}`,
    };
  }

  private async choose(request: HomeActionRequest, pages: readonly HomeHubPage[]): Promise<Resolution> {
    if (pages.length === 1) return { page: pages[0] };
    const { choice } = await this.selector.select({
      utterance: request.text,
      candidates: pages.map(({ id, label }) => ({ id, label, fingerprint: id, operation: 'click' })),
      literalValues: [],
      signal: request.signal,
    });
    if (choice.kind !== 'act')
      return choice.kind === 'ask' ? this.ask(pages) : { status: 'none', reason: choice.reason };
    const page = pages.find((candidate) => candidate.id === choice.targetId);
    return page && choice.operation === 'click' ? { page } : { status: 'blocked', reason: 'home_page_not_offered' };
  }

  async resolve(request: HomeActionRequest, assertCurrent: () => Promise<void>): Promise<Resolution> {
    const discovery = await this.pages.read(request.userId);
    await assertCurrent();
    const previous = this.selected.get(request);
    if (previous)
      return 'pages' in discovery && discovery.pages.some((page) => page.id === previous.id)
        ? { page: previous }
        : { status: 'stale', reason: 'home_page_changed: 选中的家内页面已变化，请重新选择。' };
    if (!('pages' in discovery)) {
      this.offered = undefined;
      return discovery;
    }
    if (this.offered && (this.offered.expiresAt <= Date.now() || this.offered.signature !== signature(discovery.pages)))
      return this.ask(discovery.pages, true);
    const result = await this.choose(request, discovery.pages);
    await assertCurrent();
    if (!('page' in result)) {
      if (result.status === 'none') this.offered = undefined;
      return result;
    }
    this.offered = undefined;
    if (!(await this.pages.current(request.userId, result.page)))
      return { status: 'stale', reason: 'home_page_changed: 选中的家内页面已变化，请重新选择。' };
    await assertCurrent();
    this.selected.set(request, result.page);
    return result;
  }
}
