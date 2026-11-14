// Answers "which Workbox route would handle this GET?" for service worker policy tests.
// Matching follows workbox-routing: routes are tried in registration order; a string route matches
// the exact URL resolved against the worker origin; a RegExp route matches the full href, but a
// cross-origin URL only when the match starts at index 0; a function route matches when it returns
// a truthy value for { url, request, sameOrigin }.
const vm = require('node:vm');

const SERVICE_WORKER_ORIGIN = 'http://localhost:3003';

/** Workbox writes function matchers into sw.js with toString(); rebuild them the same way. */
function routesFromRuntimeCaching(runtimeCaching) {
  return runtimeCaching.map((entry) => ({
    matcher:
      typeof entry.urlPattern === 'function'
        ? new Function(`return (${entry.urlPattern.toString()})`)()
        : entry.urlPattern,
    cacheName: entry.options?.cacheName ?? entry.handler,
  }));
}

/** Executes a generated sw.js against a recording Workbox stand-in and returns its routes. */
function routesFromServiceWorker(source) {
  const routes = [];
  const strategy = (name) =>
    class {
      constructor(options = {}) {
        this.cacheName = options.cacheName ?? name;
      }
    };
  const workbox = new Proxy(
    {
      registerRoute(matcher, handler, method = 'GET') {
        if (method === 'GET') routes.push({ matcher, cacheName: handler.cacheName });
      },
      NetworkOnly: strategy('NetworkOnly'),
      NetworkFirst: strategy('NetworkFirst'),
      CacheFirst: strategy('CacheFirst'),
      StaleWhileRevalidate: strategy('StaleWhileRevalidate'),
    },
    { get: (target, key) => (key in target ? target[key] : function workboxStandIn() {}) },
  );
  // In a worker the global object is `self`; the generated loader reads both `define` and `self.define`.
  const self = {
    define: (_deps, factory) => factory(workbox),
    skipWaiting() {},
    addEventListener() {},
    importScripts() {},
    URL,
    location: new URL(SERVICE_WORKER_ORIGIN),
  };
  self.self = self;
  vm.runInNewContext(source, self);
  return routes;
}

function routeMatches(matcher, context) {
  const { url, sameOrigin } = context;
  if (typeof matcher === 'string') return new URL(matcher, SERVICE_WORKER_ORIGIN).href === url.href;
  // A RegExp built inside the generated sw.js comes from another realm, so instanceof is not enough.
  if (Object.prototype.toString.call(matcher) === '[object RegExp]') {
    matcher.lastIndex = 0;
    const result = matcher.exec(url.href);
    return Boolean(result) && (sameOrigin || result.index === 0);
  }
  return Boolean(matcher(context));
}

/** Returns the cacheName of the first route that would handle `href`, or null. */
function matchRoute(routes, href, { headers = {} } = {}) {
  const url = new URL(href);
  const context = {
    url,
    sameOrigin: url.origin === SERVICE_WORKER_ORIGIN,
    request: { url: href, headers: new Map(Object.entries(headers)) },
  };
  return routes.find(({ matcher }) => routeMatches(matcher, context))?.cacheName ?? null;
}

/** Requests the service worker must leave to the browser: API and Socket.IO, same-origin and direct. */
const API_TRAFFIC_SAMPLES = [
  'http://localhost:3004/api/threads/thread_a/artifacts?view=works',
  'http://localhost:3004/api/workspace/file/raw?worktreeId=w&path=docs/a.png',
  'http://localhost:3004/socket.io/?EIO=4&transport=polling',
  'http://localhost:3003/api/threads',
  'http://localhost:3003/api/workspace/file/raw?worktreeId=w&path=docs/a.png',
  'http://localhost:3003/api/exports/report.json',
  'http://localhost:3003/socket.io/?EIO=4&transport=polling',
];

module.exports = {
  API_TRAFFIC_SAMPLES,
  SERVICE_WORKER_ORIGIN,
  matchRoute,
  routesFromRuntimeCaching,
  routesFromServiceWorker,
};
