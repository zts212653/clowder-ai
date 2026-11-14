const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
];

/** These tests replace global fetch; their transport must never inherit the host's outer proxy. */
export function isolateQuotaFetchStub(testContext) {
  const previous = PROXY_KEYS.map((key) => [key, process.env[key]]);
  for (const key of PROXY_KEYS) delete process.env[key];
  testContext.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
