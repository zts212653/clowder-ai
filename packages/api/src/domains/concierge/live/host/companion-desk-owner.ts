import {
  type DeskDelivery,
  type DeskSettlement,
  deskSettleInputSchema,
  toDeskText,
  type WorkReference,
  workReferenceCardSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { SuggestionDesk } from '../../../suggestions/desk-delivery.js';
import { companionAuthorName } from './companion-author-name.js';
import type { DeskAvatarImage } from './companion-desk-avatar.js';

/**
 * F335 交付三：桌面投递的私有 Host 管道（同 app-assist：只在可信内核和 API 之间，不经渲染器校验）。
 * 内核问「有什么要带」/ 回传处置；API 告诉内核「可能有新的了」。东西本身留在「给人的东西」。
 */
export const deskOwnerCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('next'), returning: z.boolean() }).strict(),
  z.object({ kind: z.literal('settle'), settle: deskSettleInputSchema }).strict(),
  z.object({ kind: z.literal('avatar'), catId: z.string().min(1).max(120) }).strict(),
]);
export type DeskOwnerCommand = z.infer<typeof deskOwnerCommand>;

export type DeskOwnerDelivery = Omit<DeskDelivery, 'items'> & {
  items: Array<DeskDelivery['items'][number] & { catName: string }>;
};
/** `opened`: Clowder AI was brought forward on the work's card in its conversation. */
export type DeskOwnerSettlement = Omit<DeskSettlement, 'open'> & { opened?: boolean };

export interface DesktopDeskOwner {
  request(command: unknown): Promise<unknown>;
  watch(listener: () => void): Promise<() => Promise<void>>;
}

export interface CompanionDeskOwnerOptions {
  desk: SuggestionDesk;
  ownerUserId: string;
  assertCurrent: () => Promise<void>;
  messages: { getById(id: string): unknown };
  /** The bringer's small avatar; null when the cat has none the Host can read. */
  readAvatar?(catId: string): Promise<DeskAvatarImage | null>;
  /** Opens Clowder AI on that card (the same opener the companion uses for decision cards). */
  openCard(destination: { threadId: string; messageId: string; blockId: string }): Promise<boolean>;
}

async function cardBlockId(
  messages: CompanionDeskOwnerOptions['messages'],
  messageId: string,
  work: WorkReference,
): Promise<string | undefined> {
  const message = (await messages.getById(messageId)) as { extra?: { rich?: { blocks?: unknown[] } } } | null;
  for (const block of message?.extra?.rich?.blocks ?? []) {
    const card = workReferenceCardSchema.safeParse(block);
    if (!card.success) continue;
    const { reference } = card.data.meta;
    if (reference.contentRef === work.contentRef && reference.ownerRevision === work.ownerRevision) return card.data.id;
  }
  return undefined;
}

/** Bound to the authenticated owner and the Host execution lease, like `CompanionAppAssistOwner`. */
export class CompanionDeskOwner implements DesktopDeskOwner {
  constructor(private readonly options: CompanionDeskOwnerOptions) {}

  async request(input: unknown): Promise<DeskOwnerDelivery | DeskOwnerSettlement | DeskAvatarImage | null> {
    const command = deskOwnerCommand.parse(input);
    const { desk, ownerUserId, assertCurrent } = this.options;
    await assertCurrent();
    if (command.kind === 'avatar') return (await this.options.readAvatar?.(command.catId)) ?? null;
    if (command.kind === 'next') {
      const delivery = await desk.next(ownerUserId, { returning: command.returning });
      await assertCurrent();
      if (!delivery) return null;
      return {
        ...delivery,
        items: delivery.items.map((item) => ({ ...item, catName: toDeskText(companionAuthorName(item.catId), 60) })),
      };
    }
    const { open, ...settlement } = await desk.settle(ownerUserId, command.settle);
    if (!open) return settlement;
    const blockId = await cardBlockId(this.options.messages, open.messageId, open.work);
    await assertCurrent();
    const opened = blockId
      ? await this.options.openCard({ threadId: open.threadId, messageId: open.messageId, blockId })
      : false;
    return { ...settlement, opened };
  }

  async watch(listener: () => void): Promise<() => Promise<void>> {
    await this.options.assertCurrent();
    const off = this.options.desk.watch(this.options.ownerUserId, listener);
    return async () => off();
  }
}
