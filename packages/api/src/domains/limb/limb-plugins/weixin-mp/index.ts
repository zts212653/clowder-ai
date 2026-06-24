/**
 * Weixin-MP limb plugin package — platform-specific handlers
 * for the generic PluginLimbAdapter framework.
 *
 * Follows the IM connector plugin-package pattern:
 * generic framework in `domains/limb/`, per-platform code in
 * `domains/limb/limb-plugins/<platform>/`.
 */
export { weixinMpHandlers } from './handlers.js';
export { markdownToWxHtml } from './markdown-to-wx-html.js';
