const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const configPath = path.resolve(__dirname, '../next.config.js');
const packageJsonPath = path.resolve(__dirname, '../package.json');
const ENV_KEYS = [
  'NEXT_PUBLIC_API_URL',
  'API_SERVER_PORT',
  'FRONTEND_PORT',
  'CAT_CAFE_WEB_BUILD_REVISION',
  'CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED',
  'CAT_CAFE_DEPLOYMENT_ID',
  'CAT_CAFE_F307_WORKBENCH_GATE_ACTIVATION',
  'ENABLE_PWA_IN_DEV',
  'CAT_CAFE_WEB_TEST_DIST_DIR',
  'CAT_CAFE_WEB_TEST_TSCONFIG',
  'NODE_ENV',
];

function withEnv(overrides, run) {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, overrides);
    delete require.cache[configPath];
    return run(require(configPath));
  } finally {
    delete require.cache[configPath];
    for (const key of ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadConfigWithPwaCapture() {
  let capturedPwaOptions;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@ducanh2912/next-pwa') {
      return {
        default: (pwaOptions) => {
          capturedPwaOptions = pwaOptions;
          return (config) => config;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[configPath];
    require(configPath);
    return capturedPwaOptions;
  } finally {
    delete require.cache[configPath];
    Module._load = originalLoad;
  }
}

describe('next.config rewrites', () => {
  it('proxies /api, /socket.io, and /uploads to default API port', async () => {
    await withEnv({}, async (config) => {
      const rewrites = await config.rewrites();
      assert.deepEqual(rewrites, [
        { source: '/api/:path*', destination: 'http://localhost:3004/api/:path*' },
        { source: '/socket.io/:path*', destination: 'http://localhost:3004/socket.io/:path*' },
        { source: '/uploads/:path*', destination: 'http://localhost:3004/uploads/:path*' },
      ]);
    });
  });

  it('respects NEXT_PUBLIC_API_URL', async () => {
    await withEnv({ NEXT_PUBLIC_API_URL: 'http://myhost:9000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://myhost:9000/api/:path*');
      assert.equal(rewrites[1].destination, 'http://myhost:9000/socket.io/:path*');
      assert.equal(rewrites[2].destination, 'http://myhost:9000/uploads/:path*');
    });
  });

  it('respects API_SERVER_PORT', async () => {
    await withEnv({ API_SERVER_PORT: '4000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://localhost:4000/api/:path*');
    });
  });

  it('respects FRONTEND_PORT (API = frontend + 1)', async () => {
    await withEnv({ FRONTEND_PORT: '5000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://localhost:5001/api/:path*');
    });
  });

  it('embeds the exact Web bundle revision into client code', () => {
    const revision = 'a'.repeat(40);
    withEnv({ CAT_CAFE_WEB_BUILD_REVISION: revision }, (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION, revision);
    });
  });

  it('can require document/server revision verification in the browser regression harness', () => {
    withEnv({ CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED: '1' }, (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED, '1');
    });
  });

  it('marks ordinary development and Alpha clients as PWA-disabled', () => {
    withEnv({ NODE_ENV: 'development', CAT_CAFE_DEPLOYMENT_ID: 'alpha' }, (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_CAT_CAFE_PWA_ENABLED, '0');
    });
  });

  it('keeps the production PWA client enabled', () => {
    withEnv({ NODE_ENV: 'production', CAT_CAFE_DEPLOYMENT_ID: 'runtime' }, (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_CAT_CAFE_PWA_ENABLED, '1');
    });
  });

  it('keeps explicitly enabled development PWA semantics intact', () => {
    withEnv({ NODE_ENV: 'development', ENABLE_PWA_IN_DEV: '1' }, (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_CAT_CAFE_PWA_ENABLED, '1');
    });
  });

  it('does not expose an F307 build-time activation switch', () => {
    for (const env of [
      { NODE_ENV: 'production', CAT_CAFE_F307_WORKBENCH_GATE_ACTIVATION: '1' },
      { NODE_ENV: 'development', CAT_CAFE_DEPLOYMENT_ID: 'runtime' },
      { NODE_ENV: 'development', CAT_CAFE_DEPLOYMENT_ID: 'alpha' },
    ]) {
      withEnv(env, (config) => {
        assert.equal(Object.hasOwn(config.env ?? {}, 'NEXT_PUBLIC_F307_WORKBENCH_GATE_ALLOWED'), false);
      });
    }
  });

  it('isolates a browser test dev server from production build artifacts', () => {
    withEnv(
      {
        CAT_CAFE_WEB_TEST_DIST_DIR: '.next-test-f294-example',
        CAT_CAFE_WEB_TEST_TSCONFIG: 'tsconfig.next-test-f294-example.json',
      },
      (config) => {
        assert.equal(config.distDir, '.next-test-f294-example');
        assert.equal(config.typescript?.tsconfigPath, 'tsconfig.next-test-f294-example.json');
      },
    );
  });

  it('rejects an unpaired or unsafe browser test build path', () => {
    assert.throws(
      () => withEnv({ CAT_CAFE_WEB_TEST_DIST_DIR: '../shared-next' }, () => {}),
      /must name an isolated \.next-test-\* directory/,
    );
    assert.throws(
      () => withEnv({ CAT_CAFE_WEB_TEST_DIST_DIR: '.next-test-f294-example' }, () => {}),
      /must be provided together/,
    );
  });

  it('keeps next-pwa in dependencies because next.config requires it at build time', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    assert.equal(
      packageJson.dependencies?.['@ducanh2912/next-pwa'],
      '^10.2.9',
      'next.config.js requires @ducanh2912/next-pwa during next build, so it cannot live in devDependencies',
    );
    assert.equal(packageJson.devDependencies?.['@ducanh2912/next-pwa'], undefined);
  });

  it('does not hard reload the PWA when network connectivity returns', () => {
    const pwaOptions = loadConfigWithPwaCapture();

    assert.equal(
      pwaOptions?.reloadOnOnline,
      false,
      'Realtime chat must reconnect without next-pwa injecting location.reload() on the online event',
    );
  });

  it('retains the packaged desktop version parameter in service-worker cache keys', () => {
    const pwaOptions = loadConfigWithPwaCapture();
    const ignoredParameters = pwaOptions?.workboxOptions?.ignoreURLParametersMatching;

    assert.ok(Array.isArray(ignoredParameters), 'the PWA URL-parameter cache policy must be explicit');
    assert.equal(
      ignoredParameters.some((pattern) => pattern.test('__clowder_desktop_version')),
      false,
      'a previous package must not collapse a versioned Electron entry URL onto its cached root document',
    );
  });
});
