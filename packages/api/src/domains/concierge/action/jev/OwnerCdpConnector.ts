import type { Browser } from 'puppeteer-core';
import { loadPuppeteer } from '../../../../utils/lazy-puppeteer.js';
import { whileNotAborted } from '../../live/host/live-controlled-context.js';
import type { OwnerPageConnector } from '../../live/host/owner-page-action-contract.js';
import { readBoundedJson } from './bounded-response.js';
import { type ConfiguredPage, pageConfigSchema } from './ConfiguredJevPage.js';

export async function configuredBrowserEndpoint(
  config: Pick<ConfiguredPage, 'browserURL'>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(new URL('/json/version', config.browserURL), { redirect: 'error', signal });
  const raw = await readBoundedJson(response, signal, 8192);
  const endpoint = raw && typeof raw === 'object' && 'webSocketDebuggerUrl' in raw ? raw.webSocketDebuggerUrl : null;
  if (typeof endpoint !== 'string') throw new Error('Configured browser endpoint unavailable');
  const socket = new URL(endpoint);
  const browser = new URL(config.browserURL);
  if (
    socket.protocol !== 'ws:' ||
    socket.hostname !== '127.0.0.1' ||
    socket.port !== browser.port ||
    socket.username ||
    socket.password ||
    socket.search ||
    socket.hash ||
    !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(socket.pathname)
  )
    throw new Error('Configured browser endpoint escaped the owner grant');
  return endpoint;
}

/** Attaches to exactly one already-open configured page. Never navigates, launches, or closes the owner's page. */
export function createOwnerCdpConnector(raw: ConfiguredPage): OwnerPageConnector {
  const config = pageConfigSchema.parse(raw);
  return {
    async open(profile, signal) {
      if (
        signal.aborted ||
        profile.profileId !== config.profileId ||
        profile.url !== config.pageUrl ||
        JSON.stringify(profile.spec.targets) !==
          JSON.stringify(config.targets.map(({ id, selector, operation }) => ({ id, selector, operation }))) ||
        JSON.stringify(profile.spec.readback) !== JSON.stringify(config.readback)
      )
        throw new Error('Configured page authority unavailable');
      let browser: Browser | undefined;
      const endpoint = await configuredBrowserEndpoint(config, signal);
      const puppeteer = await whileNotAborted(signal, loadPuppeteer());
      if (signal.aborted) throw new Error('Configured page connection cancelled');
      const connecting = puppeteer.connect({
        browserWSEndpoint: endpoint,
        protocolTimeout: 5_000,
        defaultViewport: null,
        targetFilter: (target) =>
          target.type() === 'browser' || (['page', 'tab'].includes(target.type()) && target.url() === config.pageUrl),
      });
      const disconnected = () => browser?.disconnect();
      signal.addEventListener('abort', disconnected, { once: true });
      try {
        browser = await whileNotAborted(signal, connecting);
        const pages = await whileNotAborted(signal, browser.pages());
        const matches = pages.filter((page) => page.url() === config.pageUrl);
        if (matches.length !== 1 || !matches[0] || signal.aborted)
          throw new Error('Configured page missing or ambiguous');
        return {
          page: matches[0],
          async close() {
            signal.removeEventListener('abort', disconnected);
            browser?.disconnect();
          },
        };
      } catch {
        signal.removeEventListener('abort', disconnected);
        browser?.disconnect();
        void connecting.then((late) => late.disconnect()).catch(() => {});
        throw new Error('Configured page connection unconfirmed');
      }
    },
  };
}
