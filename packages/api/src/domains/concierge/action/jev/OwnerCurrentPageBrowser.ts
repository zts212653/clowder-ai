import type { Browser, Target } from 'puppeteer-core';
import { z } from 'zod';
import { loadPuppeteer } from '../../../../utils/lazy-puppeteer.js';
import { whileNotAborted } from '../../live/host/live-controlled-context.js';
import type { OwnerPageHandle } from '../../live/host/owner-page-action-contract.js';
import { readBoundedJson } from './bounded-response.js';
import { browserEndpointSchema } from './ConfiguredJevPage.js';
import { configuredBrowserEndpoint } from './OwnerCdpConnector.js';

export const currentPageConfigSchema = z
  .object({
    mode: z.literal('owner-selected'),
    profileId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/),
    browserURL: browserEndpointSchema,
    allowJevProjection: z.literal(true),
  })
  .strict();
export type CurrentPageConfig = z.infer<typeof currentPageConfigSchema>;
export interface CurrentBrowserPage {
  id: string;
  url: string;
  title: string;
}
// Chromium's pinned CDP adapter exposes this identity; fail closed if the adapter has no such identity.
function cdpTargetId(target: Target): string | undefined {
  return '_targetId' in target && typeof target._targetId === 'string' ? target._targetId : undefined;
}

const excluded = new Set([3001, 3002, 3003, 3011, 3012, 4111, 6397, 6398, 6399]);
export function selectableOwnerPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      raw.length <= 2048 &&
      !url.username &&
      !url.password &&
      !(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && excluded.has(Number(url.port)))
    );
  } catch {
    return false;
  }
}

export async function listCurrentBrowserPages(
  config: CurrentPageConfig,
  signal: AbortSignal,
): Promise<CurrentBrowserPage[]> {
  const response = await fetch(new URL('/json/list', config.browserURL), { signal, redirect: 'error' });
  const raw = await readBoundedJson(response, signal, 65_536);
  const pages = z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
          type: z.string(),
          url: z.string(),
          title: z.string().max(4096),
        })
        .passthrough(),
    )
    .max(128)
    .parse(raw);
  return pages
    .filter((page) => page.type === 'page' && selectableOwnerPage(page.url))
    .slice(0, 32)
    .map(({ id, url, title }) => ({ id, url, title: title.slice(0, 512) }));
}

/** Only the owner-chosen page ID is exposed; URL equality never chooses between duplicate pages. */
export async function openCurrentBrowserPage(
  config: CurrentPageConfig,
  selected: CurrentBrowserPage,
  signal: AbortSignal,
): Promise<OwnerPageHandle> {
  const current = (await listCurrentBrowserPages(config, signal)).find((page) => page.id === selected.id);
  if (!current || current.url !== selected.url || current.title !== selected.title)
    throw new Error('Selected page changed');
  const endpoint = await configuredBrowserEndpoint(config, signal);
  const puppeteer = await whileNotAborted(signal, loadPuppeteer());
  signal.throwIfAborted();
  let browser: Browser | undefined;
  const connecting = puppeteer.connect({
    browserWSEndpoint: endpoint,
    defaultViewport: null,
    protocolTimeout: 5_000,
    // The pinned Puppeteer adapter auto-attaches page targets through their tab containers.
    // A matching container permits discovery, while every child page still needs the exact owner-chosen ID.
    targetFilter: (target) =>
      target.type() === 'browser' ||
      (['tab'].includes(target.type()) && target.url() === selected.url) ||
      (target.type() === 'page' && cdpTargetId(target) === selected.id),
  });
  const disconnect = () => browser?.disconnect();
  signal.addEventListener('abort', disconnect, { once: true });
  try {
    browser = await whileNotAborted(signal, connecting);
    const pages = await whileNotAborted(signal, browser.pages());
    const page = pages.find((item) => cdpTargetId(item.target()) === selected.id);
    if (signal.aborted || pages.length !== 1 || !page || page.url() !== selected.url)
      throw new Error('Selected page unavailable');
    signal.removeEventListener('abort', disconnect);
    return {
      page,
      async close() {
        signal.removeEventListener('abort', disconnect);
        browser?.disconnect();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', disconnect);
    browser?.disconnect();
    void connecting.then((late) => late.disconnect()).catch(() => {});
    throw error;
  }
}
