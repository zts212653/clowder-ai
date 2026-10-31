import type { Server } from 'node:http';
import type { Browser, BrowserContext, Page } from 'puppeteer-core';
import type { CdpPageActionSpec } from './CdpPageBrowserTask.js';
import { createLocalNoteTrialProfile } from './LocalNoteTrialProfile.js';

export interface LocalNoteTrialPageHandle {
  readonly page: Page;
  close(): Promise<void>;
}

export interface LocalNoteTrialConnector {
  open(
    profile: { readonly profileId: string; readonly url: string; readonly spec: CdpPageActionSpec },
    signal: AbortSignal,
  ): Promise<LocalNoteTrialPageHandle>;
}

function whileNotAborted<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Local note connector stopped'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Local note connector stopped'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function closeWithin(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Local note connector cleanup unconfirmed')), 160);
  });
  try {
    await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireHostedFixture(fixture: { readonly server: Server; readonly url: string }): void {
  const address = fixture.server.address();
  if (
    !fixture.server.listening ||
    !address ||
    typeof address === 'string' ||
    address.address !== '127.0.0.1' ||
    fixture.url !== `http://127.0.0.1:${address.port}/`
  )
    throw new Error('Host-owned local note fixture unavailable');
}

function requireNamedProfile(
  named: ReturnType<typeof createLocalNoteTrialProfile>,
  profile: { readonly profileId: string; readonly url: string; readonly spec: CdpPageActionSpec },
  signal: AbortSignal,
): void {
  if (
    signal.aborted ||
    profile.profileId !== named.profileId ||
    profile.url !== named.url ||
    JSON.stringify(profile.spec) !== JSON.stringify(named.spec)
  )
    throw new Error('Local note connector authority unavailable');
}

async function openExactPage(
  context: BrowserContext,
  url: string,
  signal: AbortSignal,
  settlements: Promise<boolean>[],
): Promise<Page> {
  const creatingPage = context.newPage();
  settlements.push(
    creatingPage
      .then(
        async (late) => {
          if (signal.aborted) await late.close();
        },
        () => {},
      )
      .then(
        () => true,
        () => false,
      ),
  );
  const page = await whileNotAborted(signal, creatingPage);
  if (signal.aborted) throw new Error('Local note connector stopped');
  const navigating = page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5_000 });
  settlements.push(
    navigating.then(
      () => true,
      () => true,
    ),
  );
  await whileNotAborted(signal, navigating);
  return page;
}

/** Only the Host that started the disposable fixture may construct this connector. */
export function createHostLaunchedLocalNoteConnector(
  fixture: { readonly server: Server; readonly url: string },
  browser: Browser,
): LocalNoteTrialConnector {
  requireHostedFixture(fixture);
  const named = createLocalNoteTrialProfile(fixture.url);
  return {
    async open(profile, signal) {
      requireHostedFixture(fixture);
      requireNamedProfile(named, profile, signal);
      let context: BrowserContext | undefined;
      let closing: Promise<void> | undefined;
      // A stopped open is clean only when every started browser step and late cleanup settles.
      const settlements: Promise<boolean>[] = [];
      const startClose = (): Promise<void> => {
        if (!context) return Promise.resolve();
        const owned = context;
        closing ??= Promise.resolve().then(() => owned.close());
        return closing;
      };
      const onAbort = () => {
        void startClose().catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const creatingContext = browser.createBrowserContext();
        settlements.push(
          creatingContext
            .then(
              (created) => {
                context = created;
                if (signal.aborted) return startClose();
              },
              () => {},
            )
            .then(
              () => true,
              () => false,
            ),
        );
        context = await whileNotAborted(signal, creatingContext);
        if (signal.aborted) throw new Error('Local note connector stopped');
        const page = await openExactPage(context, named.url, signal, settlements);
        if (signal.aborted || page.url() !== named.url || !fixture.server.listening)
          throw new Error('Local note connector page changed');
        return {
          page,
          close() {
            return startClose();
          },
        };
      } catch (error) {
        try {
          await closeWithin(
            Promise.all([
              ...settlements,
              startClose().then(
                () => true,
                () => false,
              ),
            ]).then((results) => {
              if (results.some((result) => !result)) throw new Error('Local note connector cleanup unconfirmed');
            }),
          );
        } catch {
          throw new Error('Local note connector cleanup unconfirmed', { cause: error });
        }
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
