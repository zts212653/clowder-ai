/**
 * F247 AC-B1c-11: ChatGPT chat URL validator.
 *
 * Defense against db-write injection — only canonical `https://chatgpt.com/c/<uuid>`
 * shaped URLs are accepted as `cloudCatBindings` values.
 *
 * Validated BOTH at write time (PATCH /api/threads/:id/cloud-bindings, bridge URL capture)
 * AND read time (before bridge navigates to a bound URL). See F247 KD-20 / KD-21.
 */

/**
 * Strict regex for ChatGPT chat URL canonical form.
 *
 * Allowed: `https://chatgpt.com/c/<id>` with optional trailing slash.
 * id = `[a-zA-Z0-9-]+` (UUID-ish; ChatGPT uses chat ids like `6a3e13fb-5dc4-83e8-aaed-b494abc0ac22`).
 *
 * NOT allowed: subdomains, http, query strings, hash fragments, paths beyond `/c/<id>`.
 */
export const CHATGPT_CHAT_URL_REGEX = /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+\/?$/;

/** Returns true iff the given string is a valid ChatGPT chat URL per AC-B1c-11. */
export function isValidChatGptChatUrl(url: unknown): url is string {
  return typeof url === 'string' && CHATGPT_CHAT_URL_REGEX.test(url);
}
