import { createRetryableLoader } from './retryable-loader.js';

export const loadPuppeteer = createRetryableLoader(async () => (await import('puppeteer-core')).default);
