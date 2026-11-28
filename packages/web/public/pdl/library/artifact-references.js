/* Software-artifact references. No network reads, file access or approval authority. */
'use strict';
const ARTIFACT_KINDS = ['pr', 'commit', 'issue', 'file'];
const ARTIFACT_REPO = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
function artifactReference(kind, repository, value) {
  if (kind === 'file') {
    const path = value.replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '');
    const relative = /^[\w.@-]+\/.+\.[a-z][a-z\d]{0,11}(?::\d+(?:-\d+)?)?$/i.test(path);
    const documentName = /^[\w.@()-]+\.(?:md|mdx|markdown|txt|json|ya?ml|toml|pen|html?)(?::\d+(?:-\d+)?)?$/i.test(path);
    if ((!relative && !documentName) || /[\u0000-\u001f<>"\\]/.test(path) || path.split('/').some(function (p) { return p === '..' || p === '.'; })) return null;
    return { kind: kind, key: 'file:' + path, path: path, label: path.split('/').pop(), title: path };
  }
  if (!repository || !ARTIFACT_REPO.test(repository)) return null;
  const repo = repository.toLowerCase(), id = String(value).toLowerCase();
  if (kind === 'commit' ? !/^[a-f\d]{7,40}$/.test(id) : !/^[1-9]\d*$/.test(id)) return null;
  const route = kind === 'pr' ? 'pull' : kind === 'issue' ? 'issues' : 'commit';
  const url = 'https://github.com/' + repo + '/' + route + '/' + id;
  return { kind: kind, repository: repo, id: id, key: kind + ':' + repo + ':' + id,
    label: kind === 'commit' ? id.slice(0, 7) : '#' + id, title: repo + (kind === 'commit' ? '@' : '#') + id, url: url };
}
function artifactUrlReference(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
  const m = /^\/([^/]+\/[^/]+)\/(pull|issues|commit)\/([a-f\d]+)(?:\/(?:files|commits|checks))?\/?$/i.exec(url.pathname);
  const ref = m ? artifactReference(m[2].toLowerCase() === 'pull' ? 'pr' : m[2].toLowerCase() === 'issues' ? 'issue' : 'commit', m[1], m[3]) : null;
  return ref ? Object.assign(ref, { url: url.href, explicitUrl: true }) : null;
}
function artifactReferenceSpans(text, repository) {
  const spans = [], urls = [];
  function add(start, end, ref) {
    if (ref && !urls.some(function (x) { return start < x.end && end > x.start; }) && !spans.some(function (x) { return start < x.end && end > x.start; })) spans.push({ start: start, end: end, ref: ref });
  }
  function scan(pattern, resolve, valueGroup) {
    let m;
    while ((m = pattern.exec(text))) {
      const start = valueGroup ? m.index + m[0].lastIndexOf(m[valueGroup]) : m.index;
      add(start, m.index + m[0].length, resolve(m));
    }
  }
  const urlPattern = /https?:\/\/[^\s<>"`\u4e00-\u9fff，。；、（）]+/gi;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(text))) {
    const value = urlMatch[0].replace(/[.,;!?)\]]+$/, '');
    add(urlMatch.index, urlMatch.index + value.length, artifactUrlReference(value));
    urls.push({ start: urlMatch.index, end: urlMatch.index + value.length });
  }
  scan(/\b(?:PR|pull request)\s+(?:([a-z\d][a-z\d-]*\/[a-z\d_.-]+))?#([1-9]\d*)\b/gi, function (m) { return artifactReference('pr', m[1] || repository, m[2]); });
  scan(/\b([a-z\d][a-z\d-]*\/[a-z\d_.-]+)#([1-9]\d*)\b/gi, function (m) { return artifactReference('issue', m[1], m[2]); });
  scan(/\bpull\/([1-9]\d*)\b/gi, function (m) { return m.index && /[\w/]/.test(text[m.index - 1]) ? null : artifactReference('pr', repository, m[1]); });
  scan(/\b(?:HEAD|commit)(?:\s*[@:=]\s*|\s+)([a-f\d]{7,40})\b/gi, function (m) { return artifactReference('commit', repository, m[1]); }, 1);
  scan(/(?:\.\/)?[\w.@-]+\/[\w./@()\u4e00-\u9fff-]+\.[a-z][a-z\d]{0,11}(?::\d+(?:-\d+)?)?/gi, function (m) { return m.index && /[\w/.-]/.test(text[m.index - 1]) ? null : artifactReference('file', repository, m[0]); });
  scan(/\b[\w.@()-]+\.(?:md|mdx|markdown|txt|json|ya?ml|toml|pen|html?)(?::\d+(?:-\d+)?)?\b/gi, function (m) { return m.index && /[\w/.-]/.test(text[m.index - 1]) ? null : artifactReference('file', repository, m[0]); });
  scan(/\b[a-f\d]{40}\b/gi, function (m) { return artifactReference('commit', repository, m[0]); });
  scan(/#[1-9]\d*\b/g, function (m) {
    if (m.index && /[\w#]/.test(text[m.index - 1])) return null;
    if (m.index && text[m.index - 1] === '/' && !/#[1-9]\d*\/$/.test(text.slice(0, m.index))) return null;
    return artifactReference('issue', repository, m[0].slice(1));
  });
  return spans.sort(function (a, b) { return a.start - b.start; });
}
function artifactReferenceGroups(references) {
  const unique = new Map();
  references.forEach(function (ref) {
    if (ref.kind === 'commit' && ref.id.length < 40) {
      const longer = references.filter(function (other) { return other.kind === 'commit' && other.repository === ref.repository && other.id.length > ref.id.length && other.id.startsWith(ref.id); });
      const identities = new Map(longer.map(function (other) { return [other.id, other]; }));
      if (identities.size === 1) ref = identities.values().next().value;
    }
    if (!unique.get(ref.key)?.explicitUrl) unique.set(ref.key, ref);
  });
  // A bare #number shares the explicitly stated PR identity only in that repository.
  unique.forEach(function (ref) { if (ref.kind === 'pr') unique.delete('issue:' + ref.repository + ':' + ref.id); });
  return ARTIFACT_KINDS.map(function (kind) { return { kind: kind, items: Array.from(unique.values()).filter(function (ref) { return ref.kind === kind; }) }; }).filter(function (g) { return g.items.length; });
}
