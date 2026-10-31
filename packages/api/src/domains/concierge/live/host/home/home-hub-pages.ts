import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import type { HomeActionNotice } from '../../../action/HomeActionController.js';
import { sha256 } from '../page-action/live-page-action-authority-contract.js';
import type { HomeHubEmitter } from './home-hub-delivery.js';
import { type HomeHubState, homeHubStateSchema } from './home-hub-targets.js';
import type { HomeWindowCapabilities } from './home-window-capabilities.js';

/** A fresh owner-window observation. The token is never sent to the selector or returned as a choice. */
export interface HomeHubPage {
  readonly id: string;
  readonly label: string;
  readonly state: HomeHubState;
}
export type HomePageDiscovery = { readonly pages: readonly HomeHubPage[] } | HomeActionNotice;

function unavailablePages(replies: readonly unknown[], connected: boolean): HomeActionNotice {
  if (replies.some((reply) => reply !== null))
    return { status: 'unavailable', reason: 'home_capability_invalid: 页面凭证已过期或无效，请重新连接家内页面。' };
  if (replies.length)
    return { status: 'unavailable', reason: 'home_not_visible: 已连接页面当前不可见，请切到要操作的家内页面。' };
  return connected
    ? { status: 'unavailable', reason: 'home_unresponsive: 已登记的家内页面未回应，请检查连接后再试。' }
    : { status: 'unavailable', reason: 'home_not_connected: 没有已连接的家内页面，请打开已登录的 Hub 页面。' };
}

export class HomeHubPages {
  constructor(
    private readonly emitter: HomeHubEmitter,
    private readonly clients: HomeWindowCapabilities,
    private readonly threads: Pick<IThreadStore, 'list'>,
  ) {}

  async read(ownerUserId: string): Promise<HomePageDiscovery> {
    const sockets = this.clients.connections(ownerUserId);
    let replies: unknown[];
    try {
      replies = await this.emitter.emitWithAck(ownerUserId, 'home:inspect', {}, 1_500, sockets);
    } catch {
      return { status: 'unavailable', reason: 'home_unresponsive: 家内页面未及时回应，请检查连接后再试。' };
    }
    const states = new Map<string, HomeHubState>();
    const conflicting = new Set<string>();
    for (const reply of replies) {
      const parsed = homeHubStateSchema.safeParse(reply);
      if (!parsed.success || !this.clients.owns(ownerUserId, parsed.data.clientId, parsed.data.clientToken)) continue;
      const previous = states.get(parsed.data.clientId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(parsed.data)) conflicting.add(parsed.data.clientId);
      states.set(parsed.data.clientId, parsed.data);
    }
    for (const id of conflicting) states.delete(id);
    if (!states.size) return unavailablePages(replies, sockets.length > 0);
    const threads = await this.threads.list(ownerUserId);
    const ordered = [...states.values()].sort(
      (a, b) => a.route.localeCompare(b.route) || a.clientId.localeCompare(b.clientId),
    );
    return {
      pages: ordered.map((state, index) => {
        const thread = threads.find((candidate) => candidate.id === state.threadId && !candidate.deletedAt);
        const title = thread?.title?.trim();
        return {
          id: `home-page-${sha256(JSON.stringify(state))}`,
          label: `页面${index + 1}：${title ? `对话「${title.slice(0, 120)}」；` : ''}${state.route.slice(0, 300)}`,
          state,
        };
      }),
    };
  }

  async current(ownerUserId: string, page: HomeHubPage): Promise<boolean> {
    const observed = await this.read(ownerUserId);
    return 'pages' in observed && observed.pages.some((candidate) => candidate.id === page.id);
  }
}
