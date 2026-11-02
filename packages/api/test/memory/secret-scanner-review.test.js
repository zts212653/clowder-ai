// Issue #1450 / PR #1451: preserve whutzefengxie-ops' regression matrix and
// zts212653's review 5197794663 counterexamples through the production scanner.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { it } from 'node:test';
import { SecretScanner } from '../../dist/domains/memory/SecretScanner.js';

const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
const assignments = [
  `FOO="hello world" API_TOKEN="${value}"`,
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
  assert.equal(SecretScanner.scan('password = "CorrectHorse/BatteryStaple/PurpleCloud/Sunshine"', 'x.md').length, 1);
});

it('does not borrow a value from another assignment or a URL', () => {
  for (const line of [
    'key=',
    'export API_TOKEN = ',
    `api_key = short; description = "${value}"`,
    `api_key: https://example.com/docs/credentials?description=${value}`,
  ]) {
    assert.deepEqual(SecretScanner.scan(line, 'fixture.md'), []);
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
  assert.ok(performance.now() - start < 1500, 'two million-character lines must finish within 1.5s');
});
