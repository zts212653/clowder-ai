import { createRetryableLoader } from './retryable-loader.js';

export const loadQRCode = createRetryableLoader(async () => (await import('qrcode')).default);
