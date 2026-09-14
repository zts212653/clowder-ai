// Retarget the API origins baked into `.next/routes-manifest.json`.
//
// Measured against Next.js 14.2.35: the `rewrites()` block of next.config.js is
// resolved at BUILD time and written into `.next/routes-manifest.json`. At
// `next start` the config is re-evaluated and its result is IGNORED, because
// routing reads the manifest; and the server does not write the manifest back
// (verified: a patched destination survived and was honoured).
//
// That is what makes a non-default port possible at all — the API origin can be
// changed at launch, but only by editing this file before the server starts.
// Changing API_SERVER_PORT in the environment is not enough.
//
// Pure logic over a parsed manifest, so the shapes and the rewriting rules are
// unit-tested; the file IO lives in service-manager.js.

/** Rewrites the desktop relies on, for logging and for the retarget summary. */
const DESKTOP_REWRITE_SOURCES = ['/api/:path*', '/socket.io/:path*', '/uploads/:path*'];

const REWRITE_BUCKETS = ['beforeFiles', 'afterFiles', 'fallback'];

/** True for an absolute http(s) URL, which is the only thing we rewrite. */
function isAbsoluteHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * Replace the origin of an absolute destination, keeping its path intact.
 * Relative destinations (`/foo`) are returned untouched — Next resolves those
 * against the request origin, so they never point at the API process.
 */
function retargetDestination(destination, apiOrigin) {
  if (!isAbsoluteHttpUrl(destination)) return destination;
  const match = /^(https?:\/\/[^/]+)([\s\S]*)$/i.exec(destination);
  if (!match) return destination;
  return `${apiOrigin}${match[2]}`;
}

function retargetRewrite(rewrite, apiOrigin) {
  if (!rewrite || typeof rewrite !== 'object') return rewrite;
  if (!isAbsoluteHttpUrl(rewrite.destination)) return rewrite;
  return { ...rewrite, destination: retargetDestination(rewrite.destination, apiOrigin) };
}

function retargetRewriteList(list, apiOrigin) {
  if (!Array.isArray(list)) return list;
  return list.map((rewrite) => retargetRewrite(rewrite, apiOrigin));
}

/**
 * Point every absolute rewrite destination at `apiOrigin`.
 *
 * Next 14 writes `rewrites` as a plain array; older manifests used an object
 * with beforeFiles / afterFiles / fallback buckets. Both are handled so a
 * version bump cannot silently disable the retarget.
 *
 * @returns a new manifest object; the input is not mutated.
 */
function retargetManifest(manifest, { apiOrigin }) {
  if (!manifest || typeof manifest !== 'object') return manifest;

  const rewrites = manifest.rewrites;
  if (Array.isArray(rewrites)) {
    return { ...manifest, rewrites: retargetRewriteList(rewrites, apiOrigin) };
  }

  if (rewrites && typeof rewrites === 'object') {
    const next = { ...manifest, rewrites: { ...rewrites } };
    for (const bucket of REWRITE_BUCKETS) {
      if (Array.isArray(rewrites[bucket])) {
        next.rewrites[bucket] = retargetRewriteList(rewrites[bucket], apiOrigin);
      }
    }
    return next;
  }

  return manifest;
}

/** Every rewrite in the manifest, flattened, for reporting. */
function listRewrites(manifest) {
  const rewrites = manifest?.rewrites;
  if (Array.isArray(rewrites)) return rewrites;
  if (rewrites && typeof rewrites === 'object') {
    return REWRITE_BUCKETS.flatMap((bucket) => (Array.isArray(rewrites[bucket]) ? rewrites[bucket] : []));
  }
  return [];
}

/** True when the manifest routes anything to an absolute API origin. */
function hasApiRewrites(manifest) {
  return listRewrites(manifest).some((rewrite) => isAbsoluteHttpUrl(rewrite?.destination));
}

/** One line per rewrite, `source -> destination`, for the desktop log. */
function describeRewrites(manifest) {
  return listRewrites(manifest).map((rewrite) => `${rewrite.source} -> ${rewrite.destination}`);
}

/** Serialize a manifest the way Next writes it: compact JSON. */
function serializeManifest(manifest) {
  return JSON.stringify(manifest);
}

module.exports = {
  DESKTOP_REWRITE_SOURCES,
  describeRewrites,
  hasApiRewrites,
  isAbsoluteHttpUrl,
  listRewrites,
  retargetDestination,
  retargetManifest,
  serializeManifest,
};
