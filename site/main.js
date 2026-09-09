/* Clowder AI — Site Interactivity */

// Theme toggle
function initTheme() {
  const saved = localStorage.getItem('clowder-theme');
  if (saved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  updateThemeIcon();
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem('clowder-theme', isDark ? 'dark' : 'light');
  updateThemeIcon();
}

function updateThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.innerHTML = isDark
      ? '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    return;
  }
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// Language toggle (EN / 中文)
// The dictionary lives in the classic site/i18n.js (window.I18N), loaded before
// this script. Fall back to an empty dict so a missing/blocked i18n.js degrades
// to the static English DOM instead of throwing.
const I18N = (typeof window !== 'undefined' && window.I18N) || { en: {}, zh: {} };

function initLang() {
  // Only apply language state on translated pages with the lang-toggle button.
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  const saved = localStorage.getItem('clowder-lang') || 'en';
  renderLangState(saved === 'zh' ? 'zh' : 'en');
}

function renderLangState(lang) {
  document.documentElement.lang = lang;
  const btn = document.getElementById('lang-toggle');
  if (btn) btn.textContent = lang === 'en' ? 'EN' : '中';
  applyLang(lang);
}

function setLang(lang, { notify = true } = {}) {
  if (lang !== 'en' && lang !== 'zh') return;
  localStorage.setItem('clowder-lang', lang);
  renderLangState(lang);
  if (notify) window.dispatchEvent(new CustomEvent('clowder:languagechange', { detail: { lang } }));
}

function toggleLang() {
  const current = document.documentElement.lang || 'en';
  const next = current === 'en' ? 'zh' : 'en';
  setLang(next);
}

function applyLang(lang) {
  const dict = I18N[lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) el.innerHTML = dict[key];
  });
  for (const [keyAttr, targetAttr] of [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-label', 'label'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-title', 'title'],
  ]) {
    document.querySelectorAll(`[${keyAttr}]`).forEach((el) => {
      const key = el.getAttribute(keyAttr);
      if (dict[key]) el.setAttribute(targetAttr, dict[key]);
    });
  }
  // Re-localize download buttons whose label was replaced with textContent at
  // fetch time (their [data-i18n] span no longer exists to translate).
  document.querySelectorAll('[data-dl-fallback]').forEach(renderDownloadLabel);
  document.querySelectorAll('[data-ver]').forEach(renderVersionText);
}

// Feature tabs
function switchFeature(tabId) {
  document.querySelectorAll('.feature-tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.feature-panel').forEach((p) => p.classList.remove('active'));
  const tab = document.querySelector(`[data-tab="${tabId}"]`);
  const panel = document.getElementById(`feature-${tabId}`);
  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('active');
}

// Install tabs
function switchInstall(method) {
  document.querySelectorAll('.install-tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.install-panel').forEach((p) => p.classList.remove('active'));
  const tab = document.querySelector(`[data-install="${method}"]`);
  const panel = document.getElementById(`install-${method}`);
  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('active');
}

// Copy code to clipboard
function copyCode(btn) {
  const code = btn.closest('.code-container').querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent.trim()).then(() => {
    const orig = btn.textContent;
    btn.textContent = (I18N[document.documentElement.lang] || I18N.en)['quickstart.copied'] || 'Copied!';
    setTimeout(() => {
      // Restore in whatever language is active now (it may have changed during the delay).
      const dict = I18N[document.documentElement.lang] || I18N.en;
      btn.textContent = dict['quickstart.copy'] || orig;
    }, 1500);
  });
}

// Smooth scroll for anchor links
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.querySelector(a.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const menu = document.getElementById('mobile-menu');
        if (menu) menu.classList.add('hidden');
      }
    });
  });
}

// Mobile menu
function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('hidden');
}

// Roadmap (swimlane layout — no JS needed, purely CSS/Tailwind)
function initTimeline() {
  // Swimlane layout is static; kept as stub for DOMContentLoaded chain.
}

// Nav background on scroll
function initNavScroll() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  window.addEventListener('scroll', () => {
    nav.classList.toggle('shadow-md', window.scrollY > 20);
  });
}

// Floating TOC — shows on scroll, highlights active section
function initFloatingToc() {
  const toc = document.getElementById('floating-toc');
  if (!toc) return;

  const sections = ['features', 'scenarios', 'quickstart', 'first-steps', 'roadmap'];
  const sectionEls = sections.map((id) => document.getElementById(id)).filter(Boolean);
  const tocLinks = toc.querySelectorAll('.toc-link');

  // Show/hide TOC based on scroll position
  const heroEnd = document.querySelector('#features');
  if (!heroEnd) return;

  const showThreshold = heroEnd.offsetTop - 200;
  let tocVisible = false;

  function updateTocVisibility() {
    const shouldShow = window.scrollY > showThreshold;
    if (shouldShow !== tocVisible) {
      tocVisible = shouldShow;
      toc.style.opacity = shouldShow ? '1' : '0';
      toc.style.pointerEvents = shouldShow ? 'auto' : 'none';
    }
  }

  // Highlight active section via IntersectionObserver
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          tocLinks.forEach((l) => {
            const isActive = l.dataset.section === entry.target.id;
            l.classList.toggle('text-terracotta', isActive);
            l.classList.toggle('font-semibold', isActive);
            l.classList.toggle('bg-terracotta/5', isActive);
          });
        }
      });
    },
    { rootMargin: '-30% 0px -60% 0px' },
  );

  sectionEls.forEach((el) => observer.observe(el));
  window.addEventListener('scroll', updateTocVisibility, { passive: true });
  updateTocVisibility();
}

// GIF-like walkthrough videos: autoplay normally, hold on the first frame
// for people who request reduced motion.
function initWalkthroughVideos() {
  const videos = document.querySelectorAll('#first-steps video');
  if (!videos.length) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncPlayback = () => {
    videos.forEach((video) => {
      if (reducedMotion.matches) {
        video.pause();
        video.currentTime = 0;
      } else {
        video.play().catch(() => {});
      }
    });
  };

  syncPlayback();
  reducedMotion.addEventListener?.('change', syncPlayback);
}

// ===== Auto-fetch latest release for download buttons =====
// Point a button at a resolved asset; when the asset is absent, leave the
// static /releases/latest fallback href untouched so we never hand a visitor a
// known-wrong artifact.
// The download label is set at fetch time via textContent, which would drop a
// plain [data-i18n] span. Remember the i18n key + asset on the element so
// applyLang() can re-localize the label on a language toggle.
function renderDownloadLabel(btn) {
  const dict = I18N[document.documentElement.lang] || I18N.en;
  const key = btn.dataset.dlKey;
  const label = (key && (dict[key] || I18N.en[key])) || btn.dataset.dlFallback || '';
  const name = btn.dataset.dlName;
  btn.textContent = name ? `${label} (${name})` : label;
}

// The "Latest: <ver>" line is set after the release fetch; store the version so
// applyLang() can re-localize the "Latest:" prefix on a language toggle.
function renderVersionText(el) {
  const dict = I18N[document.documentElement.lang] || I18N.en;
  el.textContent = el.dataset.ver
    ? `${dict['quickstart.latest'] || I18N.en['quickstart.latest']} ${el.dataset.ver}`
    : '';
}

function wireDownload(btn, asset, key, fallback) {
  if (!btn) return;
  if (asset?.browser_download_url) {
    btn.href = asset.browser_download_url;
    btn.dataset.dlKey = key || '';
    btn.dataset.dlName = asset.name || '';
    btn.dataset.dlFallback = fallback;
    renderDownloadLabel(btn);
  }
}

async function initReleaseLinks() {
  try {
    const res = await fetch('https://api.github.com/repos/zts212653/clowder-ai/releases/latest');
    if (!res.ok) return;
    const release = await res.json();
    const ver = release.tag_name || release.name || '';
    // Selection logic lives in the classic lib/release-assets.js (loaded before
    // this script, and shared with the test suite via node:vm).
    const releaseAssets = globalThis.ClowderReleaseAssets;
    if (!releaseAssets || typeof releaseAssets.selectReleaseAssets !== 'function') return;
    const { windows, macArm, macIntel } = releaseAssets.selectReleaseAssets(release.assets || []);

    wireDownload(document.getElementById('dl-windows'), windows, 'quickstart.win.download', 'Download for Windows');
    // macOS ships separate arm64 + x64 DMGs — expose both so Intel and Apple
    // Silicon users each get a build they can actually run. Apple Silicon / Intel
    // are proper nouns kept in English, so they carry no i18n key.
    wireDownload(document.getElementById('dl-mac-arm'), macArm, '', 'Apple Silicon');
    wireDownload(document.getElementById('dl-mac-intel'), macIntel, '', 'Intel');

    for (const id of ['dl-windows-version', 'dl-mac-version']) {
      const el = document.getElementById(id);
      if (el) {
        el.removeAttribute('data-i18n'); // now locale-managed via data-ver
        el.dataset.ver = ver || '';
        renderVersionText(el);
      }
    }
  } catch (_) {
    // Silently fall back to /releases/latest links
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLang();
  initSmoothScroll();
  initTimeline();
  initNavScroll();
  initWalkthroughVideos();
  initFloatingToc();
  initReleaseLinks();
});
