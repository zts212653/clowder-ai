/**
 * Weixin-MP plugin — platform-specific invoke handlers.
 *
 * Generic limb framework lives in `domains/limb/`.
 * Plugin declarations (YAML, skills) live in `plugins/weixin-mp/`.
 * This directory holds the TypeScript handler implementations.
 */
export { weixinMpHandlers } from './handlers.js';
export { markdownToWxHtml } from './markdown-to-wx-html.js';
