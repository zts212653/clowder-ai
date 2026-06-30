/**
 * Weixin-MP plugin — self-contained plugin directory.
 *
 * Contains both declarations (plugin.yaml, skills/, limbs/) and
 * TypeScript handler implementations. Generic limb framework lives
 * in `domains/limb/`.
 */
export { createWeixinMpHandlers, weixinMpHandlers } from './handlers.js';
export { markdownToWxHtml } from './markdown-to-wx-html.js';
