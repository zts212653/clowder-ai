import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from './lib/alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';

function environment(f) {
  f.preparedBuilds();
  return {
    ...f.env,
    ...namedAlphaEnvironment(
      deriveNamedAlphaCoordinates({
        mainRoot: f.mainRoot,
        instance: 'f290-communication',
        ports: NAMED_ALPHA_PORTS,
        targetSha: f.head,
      }),
    ),
  };
}

function source(f, commands, env = environment(f)) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -e\nsource "$1" --source-only >/dev/null\ntrap - EXIT INT TERM\n${commands}`,
      '_',
      join(f.alphaRoot, 'scripts/start-dev.sh'),
    ],
    { cwd: f.alphaRoot, env, encoding: 'utf8', timeout: 10_000 },
  );
}

test('the real start-dev consumer reasserts the loaded tuple after stale dotenv and binds web loopback', (t) => {
  const f = namedAlphaFixture(t);
  writeFileSync(
    join(f.alphaRoot, '.env'),
    'CAT_CAFE_ALPHA_COORDINATES=forged\nCAT_CAFE_DEPLOYMENT_ID=runtime\nCAT_CAFE_RUNTIME_ROOT=/foreign\nCAT_CAFE_DATA_DIR=/foreign\nUPLOAD_DIR=/foreign/uploads\nTRANSCRIPT_DATA_DIR=/foreign/transcripts\nANNOTATION_DATA_DIR=/foreign/stories\nFRONTEND_PORT=3001\nAPI_SERVER_HOST=0.0.0.0\nCOLLECTIVE_SERVICE_PORT=5211\nCAT_CAFE_SIDECAR_LIFECYCLE_DISABLED=0\nCONNECTOR_GATEWAY_AUTOSTART=1\n',
  );
  const result = source(f, "node -e 'console.log(JSON.stringify(process.env))'\nfrontend_launch_command");
  assert.equal(result.status, 0, result.stderr);
  const [raw, web] = result.stdout.split('\n');
  const actual = JSON.parse(raw);
  assert.equal(actual.CAT_CAFE_DEPLOYMENT_ID, 'alpha');
  assert.equal(actual.CAT_CAFE_RUNTIME_ROOT, f.alphaRoot);
  assert.equal(actual.CAT_CAFE_DATA_DIR, join(f.alphaRoot, '.cat-cafe'));
  assert.equal(actual.UPLOAD_DIR, join(f.alphaRoot, '.cat-cafe/uploads'));
  assert.equal(actual.TRANSCRIPT_DATA_DIR, join(f.alphaRoot, '.cat-cafe/transcripts'));
  assert.equal(actual.ANNOTATION_DATA_DIR, join(f.alphaRoot, '.cat-cafe/stories'));
  assert.equal(actual.API_SERVER_HOST, '127.0.0.1');
  assert.equal(actual.COLLECTIVE_SERVICE_PORT, '5511');
  assert.equal(actual.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED, '1');
  assert.equal(actual.CONNECTOR_GATEWAY_AUTOSTART, '0');
  assert.match(web, /next dev -p 5311 -H 127\.0\.0\.1$/);
});

test('named Alpha refuses even same-checkout occupied listeners without process signals', (t) => {
  const f = namedAlphaFixture(t);
  const result = source(
    f,
    'port_listen_pids() { printf "42\\n"; }\npid_cwd() { printf "%s\\n" "$PROJECT_DIR"; }\nkill() { printf "SIGNALLED\\n"; }\nkill_port 5312 API',
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /SIGNALLED/);
});

test('named startup pins global sidecar provisioning off despite inherited and dotenv ownership markers', (t) => {
  const f = namedAlphaFixture(t);
  writeFileSync(join(f.alphaRoot, '.env'), 'CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1\n');
  const result = source(f, 'printf "SIDECAR=%s\\n" "$CAT_CAFE_PROVISION_GLOBAL_SIDECAR"', {
    ...environment(f),
    CAT_CAFE_PROVISION_GLOBAL_SIDECAR: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'SIDECAR=0');
});

test('foreign replacement Redis cannot receive even a PING from named cleanup', (t) => {
  const f = namedAlphaFixture(t);
  const result = source(
    f,
    'STARTED_REDIS=true\nNAMED_ALPHA_REDIS_IDENTITY=""\nredis_ping() { printf "REDIS_READ\\n"; return 0; }\nredis-cli() { printf "REDIS_COMMAND %s\\n" "$*"; }\narchive_redis_snapshot() { :; }\nterminate_managed_pids() { :; }\nremove_redis_dev_lease() { :; }\ncleanup',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /REDIS_READ|REDIS_COMMAND/, 'missing actual ownership must not contact Redis');
});

test('a checkout dotenv cannot mint the named Alpha envelope when the entrypoint did not supply it', (t) => {
  const f = namedAlphaFixture(t);
  writeFileSync(join(f.alphaRoot, '.env'), 'CAT_CAFE_ALPHA_COORDINATES=forged\n');
  const result = source(f, 'printf "COORDS=%s\\n" "$CAT_CAFE_ALPHA_COORDINATES"', f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'COORDS=');
});
