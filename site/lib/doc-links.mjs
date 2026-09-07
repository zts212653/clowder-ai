/**
 * Pure-function URL resolution for the docs viewer.
 * Extracted from docs.html so link-rewriting logic is testable
 * without a browser DOM.
 *
 * The docs.html inline script calls resolveDocLink() and applies
 * the result to DOM elements; this module owns only the URL math.
 */

const REPO = 'zts212653/clowder-ai';
const BRANCH = 'main';
const GH_BLOB = `https://github.com/${REPO}/blob/${BRANCH}/`;
const GH_RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

/**
 * Convert a localized Markdown sibling back to the viewer's canonical route.
 * The active locale chooses the actual file in doc-locale.mjs, so keeping
 * navigation canonical also lets a later language switch return to English.
 */
export function canonicalDocPath(path) {
  if (typeof path !== 'string') return path;
  return path.replace(/\.zh-CN\.md$/i, '.md');
}

function decodeViewerHash(hash) {
  if (!hash) return '';
  try {
    return `#${decodeURIComponent(hash.slice(1))}`;
  } catch {
    return hash;
  }
}

function explicitDocLang(resolvedPath, sourcePath) {
  if (/\.zh-CN\.md$/i.test(resolvedPath)) return 'zh';
  const canonicalSource = canonicalDocPath(sourcePath);
  if (canonicalSource !== sourcePath && resolvedPath === canonicalSource) return 'en';
  return undefined;
}

/**
 * Generate the fragment shape used by Markdown hosts for a heading.
 * Unicode letters are preserved so translated documents have readable ids.
 */
export function slugDocHeading(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Add stable, duplicate-safe ids to rendered Markdown headings. */
export function assignDocHeadingIds(container) {
  const used = new Set([...container.querySelectorAll('[id]')].map((element) => element.id).filter(Boolean));

  for (const heading of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (heading.id) continue;
    const base = slugDocHeading(heading.textContent);
    if (!base) continue;

    let id = base;
    let duplicate = 0;
    while (used.has(id)) {
      duplicate += 1;
      id = `${base}-${duplicate}`;
    }
    heading.id = id;
    used.add(id);
  }
}

/**
 * Resolve a relative href found inside a rendered markdown document.
 *
 * @param {string} href      — the raw href attribute value
 * @param {string} docPath   — repo-relative path of the document being viewed
 * @param {Set<string>} loadable — set of repo-relative .md paths the viewer can load
 * @returns {{ type: 'skip' } |
 *           { type: 'viewer', path: string, hash: string, lang?: 'en' | 'zh' } |
 *           { type: 'github', url: string }}
 */
export function resolveDocLink(href, docPath, loadable) {
  if (!href || /^(https?:|mailto:|#|javascript:)/i.test(href)) {
    return { type: 'skip' };
  }
  const parsed = new URL(href, `file:///${docPath}`);
  const resolved = parsed.pathname.replace(/^\//, '');
  const encodedHash = parsed.hash || '';
  const search = parsed.search || '';

  const viewerPath = canonicalDocPath(resolved);
  if (viewerPath.endsWith('.md') && loadable.has(viewerPath)) {
    const result = { type: 'viewer', path: viewerPath, hash: decodeViewerHash(encodedHash) };
    const lang = explicitDocLang(resolved, docPath);
    if (lang) result.lang = lang;
    return result;
  }
  return { type: 'github', url: GH_BLOB + resolved + search + encodedHash };
}

/**
 * Resolve a relative image src to a GitHub raw URL.
 *
 * @param {string} src     — the raw src attribute value
 * @param {string} docPath — repo-relative path of the document being viewed
 * @returns {string|null}  — resolved raw URL, or null if absolute/data
 */
export function resolveImageSrc(src, docPath) {
  if (!src || /^(https?:|data:)/i.test(src)) return null;
  const resolved = new URL(src, `file:///${docPath}`).pathname.replace(/^\//, '');
  return GH_RAW + resolved;
}
