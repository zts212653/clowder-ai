import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createConfiguredJevPageProfile, pageConfigSchema } from './ConfiguredJevPage.js';
import { createJevPageSelector } from './JevPageSelector.js';
import { createOwnerCdpConnector } from './OwnerCdpConnector.js';
import { currentPageConfigSchema } from './OwnerCurrentPageBrowser.js';
import { createOwnerCurrentPageSource } from './OwnerCurrentPageSource.js';

async function boundedFile(path: string, maximum: number): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Jev configuration requires an absolute local file');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximum) throw new Error('Jev configuration file unavailable');
  return readFile(path, 'utf8');
}

/** Separate product composition; absent/invalid credentials fail closed, never select the lab or another model. */
export async function readConfiguredPageAction(env: NodeJS.ProcessEnv = process.env) {
  const path = env.CAT_CAFE_JEV_PAGE_CONFIG;
  if (!path) return undefined;
  const raw: unknown = JSON.parse(await boundedFile(path, 32_768));
  const config = currentPageConfigSchema.or(pageConfigSchema).parse(raw);
  const apiKey =
    env.TYPESAFE_API_KEY ??
    (env.TYPESAFE_API_KEY_FILE ? (await boundedFile(env.TYPESAFE_API_KEY_FILE, 4096)).trim() : '');
  const provider = createJevPageSelector({ apiKey });
  if ('mode' in config) return { currentPages: createOwnerCurrentPageSource(config, provider) };
  return { profile: createConfiguredJevPageProfile(config, provider), connector: createOwnerCdpConnector(config) };
}
