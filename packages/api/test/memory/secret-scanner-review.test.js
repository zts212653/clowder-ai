// Issue #1450 / PR #1451: preserve whutzefengxie-ops' regression matrix and
// zts212653's review 5197794663 counterexamples through the production scanner.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { it } from 'node:test';
import { SecretScanner } from '../../dist/domains/memory/SecretScanner.js';

const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
const assignments = [
  // zts212653, #1784 discussion_r4450434575: commas separate bindings, not declarations.
  `const description = "ok", API_TOKEN:string = "${value}";`,
  `const description = "ok", API_TOKEN: string | {provider:string} = "${value}";`,
  `const description: string = "ok", API_TOKEN: string | "absent" = "${value}";`,
  ...['let', 'var'].map((keyword) => `${keyword} description = "ok", API_TOKEN:string = "${value}";`),
  `let description: string, API_TOKEN: string = "${value}";`,
  `const first = "ok", second = 2, API_TOKEN: string = "${value}";`,
  ...[
    'pick("a", "b")',
    '["a", "b"]',
    '{name: "public", flags: [1, 2]}',
    '(() => { const localName = "ok"; return localName; })()',
  ].map((initializer) => `const description = ${initializer}, API_TOKEN:string = "${value}";`),
  `const {name} = config, API_TOKEN:string = "${value}";`,
  `const $API_TOKEN: string = "${value}";`,
  `const description = "ok", $API_TOKEN:string = "${value}";`,
  `const config = {const: "ok", apiToken: "${value}"};`,
  `const config = {const: {apiToken: "${value}"}};`,
  // zts212653, #1784 discussion_r4450208394: keep the declaration target through its type.
  `const API_TOKEN:string="${value}"`,
  ...[
    'string | {provider: string}',
    'string | {readonly provider?: string}',
    'string | "absent"',
    "string | 'absent'",
    'string | {provider: {name: string; token?: string}}',
  ].map((type) => `const API_TOKEN: ${type} = "${value}"`),
  `export env:API_TOKEN=${value}`,
  `local global:API_TOKEN=${value}`,
  `outer: {apiToken: "${value}"}`,
  `const config = {outer: {apiToken: "${value}"}}`,
  // zts212653, #1784 review 5746137352: cmd boundaries and TS type context.
  `set "API_TOKEN=${value}" && echo ready`,
  `set "API_TOKEN=${value}" & echo ready`,
  `echo ready && SET "API_TOKEN=${value}"`,
  `echo ready & SET "API_TOKEN=${value}"`,
  `(SET "API_TOKEN=${value}")`,
  ...[
    'string | Record<string, unknown>',
    'string | (() => string)',
    'Record<string, Record<string, unknown>> | string',
    'string | ((input: string) => string)',
  ].map((type) => `const API_TOKEN: ${type} = "${value}"`),
  // zts212653, #1784 review 5740204118 / discussion_r4445240560.
  ...['SET', 'Set', 'set'].flatMap((command) => [`${command} API_TOKEN=${value}`, `${command} "API_TOKEN=${value}"`]),
  ...['cfg . apiToken', 'cfg. apiToken', 'cfg .apiToken', 'cfg . nested . apiToken'].map(
    (target) => `${target} = "${value}"`,
  ),
  ...['(string | undefined)', '((string & Brand) | undefined)'].map((type) => `const API_TOKEN: ${type} = "${value}"`),
  `set "description=short"; SET "API_TOKEN=${value}"`,
  `FOO="hello world" API_TOKEN="${value}"`,
  ...['/tmp/path', 'abc/def', 'https://example.com', 'hello\\ world'].map(
    (prefix) => `FOO=${prefix} API_TOKEN="${value}"`,
  ),
  `const config = {apiToken: "${value}"}`,
  `FOO= API_TOKEN="${value}"`,
  `const foo = apiToken = "${value}"`,
  `FOO=$(cat path) API_TOKEN="${value}"`,
  `private readonly apiToken = "${value}"`,
  `API_TOKEN: string & Brand = "${value}"`,
  `const API_TOKEN: string = "${value}"`,
  `"api_key": "${value}"`,
  `api_key: ${value}`,
  `token := "${value}"`,
  `other = short; api_key = "${value}"`,
  `api_key = "short"; password = "${value}"`,
];
assignments.forEach((line) => {
  it(`detects explicit credential assignment: ${line.split(value)[0]}`, () => {
    const findings = SecretScanner.scan(line, 'fixture.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'high-entropy-secret');
    assert.ok(!findings[0].snippet.includes(value));
  });
});

it('keeps the reviewed prose boundary without exempting digit-free passwords', () => {
  for (const line of [`Note: token = "${value}"`, `see token = "${value}"`]) {
    assert.deepEqual(SecretScanner.scan(line, 'fixture.md'), []);
  }
  assert.equal(
    SecretScanner.scan(['password = "Corr', 'ectHorse/Battery', 'Staple/PurpleClo', 'ud/Sunshine"'].join(''), 'x.md')
      .length,
    1,
  );
});

it('does not borrow a value from another assignment or a URL', () => {
  for (const line of [
    'key=',
    'export API_TOKEN = ',
    `api_key = short; description = "${value}"`,
    `api_key: https://example.com/docs/credentials?description=${value}`,
    `SET "description=${value}"`,
    `set "API_TOKEN=short"; SET "description=${value}"`,
    `const description: "token" = "${value}"`,
    `declare const API_TOKEN: "absent"; const description = "${value}"`,
    `key: "label" description=${value}`,
    `declare const API_TOKEN: "${value}";`,
    'const API_TOKEN: CorrelationMessageIdTaskIdSourceToolPreviewEventId = "short"',
    `const API_TOKEN:string = "short", description:string = "${value}";`,
    `const description = "ok"; key: "label" description=${value}`,
  ]) {
    assert.deepEqual(SecretScanner.scan(line, 'fixture.md'), []);
  }
});

it('preserves the credential-name suffix boundary without a field whitelist', () => {
  for (const line of [
    'author: AdaLovelace/GraceHopper/BarbaraLiskov',
    'authors = "AdaLovelace/GraceHopper/BarbaraLiskov"',
    'authentication_method: publicKey/password/passphrase/keychain',
    'key_paths: docs/harness-feedback/eval-domains/publish',
  ]) {
    assert.deepEqual(SecretScanner.scan(line, 'ordinary.md'), []);
  }
});

it('bounds the historical long-line attack through SecretScanner.scan', { timeout: 5000 }, () => {
  SecretScanner.scan('warmup: short', 'x.md');
  const start = performance.now();
  // #1451's regex takes seconds on this failing input; staged tokenization must
  // also scan the final real assignment, rather than truncate or skip long lines.
  assert.deepEqual(SecretScanner.scan(`${'xkeyx'.repeat(200_000)}: short`, 'x.md'), []);
  assert.equal(SecretScanner.scan(`${'xkeyx'.repeat(200_000)}: short; token = "${value}"`, 'x.md').length, 1);
  for (const prefix of ['['.repeat(100_000), '${'.repeat(50_000)]) {
    assert.deepEqual(SecretScanner.scan(`${prefix}: short`, 'x.md'), []);
  }
  for (const prefix of ['='.repeat(100_000), 'key='.repeat(25_000)]) {
    assert.deepEqual(SecretScanner.scan(prefix, 'x.md'), []);
    assert.equal(SecretScanner.scan(`${prefix} token = "${value}"`, 'x.md').length, 1);
  }
  assert.equal(SecretScanner.scan(`${'key='.repeat(25_000)}${value}`, 'x.md').length, 1);
  assert.equal(SecretScanner.scan(`key=xxxkey=token=${value}`, 'x.md').length, 1);
  assert.deepEqual(SecretScanner.scan(`token=${value}xxxx`, 'x.md'), []);
  assert.deepEqual(SecretScanner.scan(`SET "${'xkeyx'.repeat(100_000)}: short`, 'x.md'), []);
  assert.equal(SecretScanner.scan(`SET "${'xkeyx'.repeat(100_000)}: short; token=${value}`, 'x.md').length, 1);
  assert.equal(
    SecretScanner.scan(`const API_TOKEN: ${'('.repeat(50_000)}string${')'.repeat(50_000)} = "${value}"`, 'x.md').length,
    1,
  );
  assert.equal(
    SecretScanner.scan(`const ${'field = "ok", '.repeat(10_000)}API_TOKEN:string = "${value}";`, 'x.md').length,
    1,
  );
  assert.ok(performance.now() - start < 1500, 'two million-character lines must finish within 1.5s');
});
