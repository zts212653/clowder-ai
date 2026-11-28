/* One presentation for message bodies, independent of the selected Markdown renderer. */
'use strict';
const ARTIFACT_ICONS = {
  pr: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M4 5.3v5.4M12 10.7V6.5a2.5 2.5 0 0 0-2.5-2.5H7M8.5 2.2 6.7 4l1.8 1.8"/>',
  commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
  issue: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>',
  file: '<path d="M9.5 2H4.2A1.2 1.2 0 0 0 3 3.2v9.6A1.2 1.2 0 0 0 4.2 14h7.6a1.2 1.2 0 0 0 1.2-1.2V5.5L9.5 2ZM9.2 2v3.8H13M5.5 8.5h5M5.5 11h3.5"/>',
  panel: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M9.5 2.5v11"/>',
};
function artifactIcon(kind) {
  const template = document.createElement('template');
  template.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ARTIFACT_ICONS[kind] + '</svg>';
  return template.content.firstChild;
}
function artifactInline(ref, text, sourceText) {
  const span = document.createElement('span');
  span.className = 'artifact-inline artifact-inline--' + ref.kind;
  span.title = ref.kind === 'commit' ? ref.id : ref.title;
  span.dataset.quoteSourceText = sourceText;
  span.textContent = ref.kind === 'commit' || ref.kind === 'file' ? ref.label : text;
  return span;
}
function artifactDock(groups, repository) {
  const dock = document.createElement('nav');
  dock.className = 'artifact-dock';
  dock.dataset.artifactDock = '';
  dock.dataset.quoteExclude = '';
  dock.setAttribute('aria-label', tc('messageArtifacts.label'));
  groups.forEach(function (group) {
    const segment = document.createElement('span');
    segment.className = 'artifact-segment artifact-segment--' + group.kind;
    segment.append(artifactIcon(group.kind));
    group.items.forEach(function (ref, i) {
      if (i) { const slash = document.createElement('span'); slash.className = 'artifact-slash'; slash.setAttribute('aria-hidden', 'true'); slash.textContent = '/'; segment.append(slash); }
      const link = document.createElement(ref.kind === 'file' ? 'button' : 'a');
      link.className = 'artifact-destination';
      link.title = ref.title;
      link.setAttribute('aria-label', tc('messageArtifacts.' + ref.kind) + ': ' + ref.title);
      if (ref.kind === 'file') { link.type = 'button'; link.dataset.act = 'fileOpen'; link.dataset.v = ref.path; }
      else { link.href = ref.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      const label = document.createElement('span');
      label.className = 'artifact-name';
      label.textContent = ref.repository && ref.repository !== repository?.toLowerCase() ? ref.repository + (ref.kind === 'commit' ? '@' : '') + ref.label : ref.label;
      link.append(label);
      if (ref.kind === 'file') { const tail = artifactIcon('panel'); tail.classList.add('artifact-panel'); link.append(tail); }
      segment.append(link);
    });
    dock.append(segment);
  });
  return dock;
}
function messageArtifactHtml(html, repository) {
  if (!html) return html;
  const root = document.createElement('div'); root.innerHTML = html;
  if (root.querySelector('[data-artifact-dock]')) return html;
  const references = [], linked = [];
  const blocked = 'pre, .md-rich, svg, math, script, style, [data-artifact-dock]';
  root.querySelectorAll('a[href],button[data-act="fileOpen"]').forEach(function (element) {
    if (element.closest(blocked)) return;
    const ref = element.tagName === 'A' ? artifactUrlReference(element.getAttribute('href')) : artifactReference('file', repository, element.dataset.v || '');
    if (ref) { references.push(ref); linked.push({ element: element, ref: ref }); }
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (node) {
    return node.parentElement.closest(blocked + ',a,button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  const nodes = []; let node;
  while ((node = walker.nextNode())) {
    const code = node.parentElement.closest('code');
    if (code) {
      const spans = artifactReferenceSpans(code.textContent, repository);
      // Inline commands and code samples keep their syntax; only a standalone reference is a value token.
      if ((spans.length !== 1 || spans[0].start !== 0 || spans[0].end !== code.textContent.length) && !/^[a-f\d]{7,40}$/i.test(code.textContent) && !artifactReference('file', repository, code.textContent)) continue;
    }
    nodes.push(node);
  }
  const context = artifactReferenceSpans(nodes.map(function (n) { return n.parentElement.closest('code') && artifactReference('file', repository, n.data) ? '' : n.data; }).join(' '), repository);
  context.forEach(function (s) { references.push(s.ref); });
  nodes.forEach(function (n) { if (n.parentElement.closest('code')) { const ref = artifactReference('file', repository, n.data); if (ref) references.push(ref); } });
  const groups = artifactReferenceGroups(references);
  if (!groups.length) return html;
  const catalog = new Map();
  groups.forEach(function (group) { group.items.forEach(function (ref) { catalog.set(ref.key, ref); }); });
  function canonical(ref) { return ref.kind === 'issue' ? catalog.get('pr:' + ref.repository + ':' + ref.id) || ref : ref; }
  linked.forEach(function (entry) {
    const label = entry.element.textContent;
    const token = artifactInline(canonical(entry.ref), label, label);
    if (entry.ref.kind === 'file' && label !== entry.ref.path) token.textContent = label;
    entry.element.replaceWith(token);
  });
  nodes.forEach(function (text) {
    let spans = artifactReferenceSpans(text.data, repository);
    if (text.parentElement.closest('code')) {
      const file = artifactReference('file', repository, text.data);
      const commit = catalog.get('commit:' + repository?.toLowerCase() + ':' + text.data.toLowerCase());
      if (file || commit) spans = [{ start: 0, end: text.data.length, ref: file || commit }];
    }
    if (!spans.length) return;
    const fragment = document.createDocumentFragment(); let at = 0;
    spans.forEach(function (s) {
      const original = text.data.slice(s.start, s.end);
      fragment.append(document.createTextNode(text.data.slice(at, s.start)), artifactInline(canonical(s.ref), /^https?:/.test(original) ? s.ref.label : original, original));
      at = s.end;
    });
    fragment.append(document.createTextNode(text.data.slice(at)));
    text.replaceWith(fragment);
  });
  const prose = document.createElement('div'); prose.className = 'artifact-prose';
  while (root.firstChild) prose.append(root.firstChild);
  root.append(prose, artifactDock(groups, repository));
  return root.innerHTML;
}
