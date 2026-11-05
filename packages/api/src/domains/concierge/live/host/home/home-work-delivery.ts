import type { HomeHubCommand, HomeWorkPublication } from './home-hub-delivery.js';
import type { HomeHubPage, HomeHubPages } from './home-hub-pages.js';

/** Source/version authority stays with the publication owner; this delivery binds its chosen window. */
export async function deliverHomeWork(input: {
  ownerUserId: string;
  resolve: () => Promise<HomeWorkPublication | null>;
  assertCurrent: () => Promise<void>;
  signal: AbortSignal;
  pages: HomeHubPages;
  page?: HomeHubPage;
  deliver(command: HomeHubCommand, verify: (receipt: Record<string, unknown>) => boolean): Promise<{ status: string }>;
}): Promise<'applied' | 'blocked' | 'unconfirmed'> {
  const { ownerUserId, resolve, assertCurrent, signal, pages } = input;
  await assertCurrent();
  const discovery = await pages.read(ownerUserId);
  await assertCurrent();
  if (signal.aborted) return 'blocked';
  if (!('pages' in discovery)) return 'unconfirmed';
  // Legacy callers without a selection may use a single page, never an arbitrary page from several.
  const page = input.page
    ? discovery.pages.find((candidate) => candidate.id === input.page?.id)
    : discovery.pages.length === 1
      ? discovery.pages[0]
      : undefined;
  if (!page) return input.page ? 'blocked' : 'unconfirmed';
  const state = page.state;
  let publication: HomeWorkPublication | null = null;
  const expiresAt = Date.now() + 10_000;
  const result = await input.deliver(
    {
      ownerUserId,
      clientId: state.clientId,
      clientToken: state.clientToken,
      signal,
      expiresAt,
      authorize: async () => {
        try {
          await assertCurrent();
          if (!(await pages.current(ownerUserId, page))) return { kind: 'blocked' };
          publication = await resolve();
          await assertCurrent();
          if (!publication || signal.aborted || Date.now() >= expiresAt || !(await pages.current(ownerUserId, page)))
            return { kind: 'blocked' };
          await assertCurrent();
          return {
            kind: 'navigate',
            clientId: state.clientId,
            baseRoute: state.route,
            expiresAt,
            action: { kind: 'publication', ...publication },
          };
        } catch {
          return { kind: 'blocked' };
        }
      },
    },
    (receipt) => {
      const shown = receipt.artifact as HomeWorkPublication['artifact'];
      return Boolean(
        publication?.artifact &&
          shown &&
          shown.contentRef === publication.artifact.contentRef &&
          shown.ownerRevision === publication.artifact.ownerRevision,
      );
    },
  );
  if (signal.aborted) return 'blocked';
  try {
    await assertCurrent();
  } catch {
    return 'blocked';
  }
  return result.status === 'applied' || result.status === 'blocked' ? result.status : 'unconfirmed';
}
