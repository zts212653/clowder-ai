import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';

const profileHome = '/tmp/f325-private-profile';
const cwd = '/tmp/f325-ordinary-project';
const options = { profileHome, selfHost: () => ({ confidence: 'none' }) };
const command = (CommandLine) =>
  decideAgyNativeHookPayload(
    {
      toolCall: { name: 'run_command', args: { CommandLine, Cwd: cwd } },
      workspacePaths: [cwd],
    },
    options,
  );

test('the native model cannot replace its private credential store or keychain preferences', () => {
  for (const suffix of [
    'Library',
    'Library/Keychains',
    'Library/Keychains/cat-cafe.keychain-db',
    'Library/Preferences',
    'Library/Preferences/com.apple.security.plist',
    '.gemini/antigravity-cli/antigravity-oauth-token',
  ]) {
    const path = `${profileHome}/${suffix}`;
    assert.equal(
      decideAgyNativeHookPayload(
        { toolCall: { name: 'write_to_file', args: { TargetFile: path } }, workspacePaths: [cwd] },
        options,
      ).decision,
      'deny',
      suffix,
    );
    assert.equal(command(`rm -rf '${path}'`).decision, 'deny', suffix);
  }
});

test('managed account file and stable data view keep the native control boundary', () => {
  const credentialHome = '/tmp/f320-selected-account';
  const managed = { ...options, credentialHome };
  for (const path of [
    `${credentialHome}/.gemini/antigravity-cli/antigravity-oauth-token`,
    `${profileHome}/.cat-cafe-account-views/${'a'.repeat(64)}/antigravity-oauth-token`,
    `${profileHome}/.cat-cafe-account-views/${'a'.repeat(64)}/settings.json`,
    `${profileHome}/.cat-cafe-account-views`,
  ]) {
    assert.equal(
      decideAgyNativeHookPayload(
        { toolCall: { name: 'write_file', args: { Path: path, Content: 'foreign' } }, workspacePaths: [cwd] },
        managed,
      ).decision,
      'deny',
      path,
    );
    assert.equal(
      decideAgyNativeHookPayload(
        {
          toolCall: { name: 'run_command', args: { CommandLine: `rm -rf '${path}'`, Cwd: cwd } },
          workspacePaths: [cwd],
        },
        managed,
      ).decision,
      'deny',
      path,
    );
  }
});

test('implicit keychain operations cannot change the host-owned authentication plane', () => {
  for (const text of [
    'security login-keychain -d user -s /tmp/foreign.keychain-db',
    'security add-certificates /tmp/fixture.pem',
    'security delete-identity -c fixture',
    'security add-trusted-cert /tmp/fixture.pem',
    'security create-keypair -n fixture',
    'security set-identity-preference -s fixture',
    'security remove-trusted-cert /tmp/fixture.pem',
    'security user-trust-settings-enable -e',
    'security trust-settings-import /tmp/fixture.plist',
    'security authorizationdb write fixture allow',
    'security execute-with-privileges /tmp/fixture-command',
    'security smartcards token -d fixture',
    'security future-control-operation',
    'security default-keychain -d user -s /tmp/other.keychain',
    'security default-keychain -s/tmp/other.keychain',
    'security list-keychains -hs /tmp/other.keychain',
    'security default-keychain -d user --unknown-option',
    'env /usr/bin/security list-keychains -d user -s /tmp/other.keychain',
    'security delete-keychain',
    'security unlock-keychain -p empty',
    'security add-generic-password -s gemini -a antigravity -w attacker',
    'security find-generic-password -s gemini -a antigravity -w',
    'security dump-keychain -d',
    'security export -t all',
    'security -i',
  ]) {
    assert.equal(command(text).decision, 'deny', text);
  }
});

test('security control operations stay protected through shell wrappers and expansions', () => {
  for (const text of [
    'command /usr/bin/security login-keychain -s /tmp/other.keychain',
    'env /usr/bin/security add-certificates /tmp/fixture.pem',
    "sh -c 'security delete-identity -c fixture'",
    'operation=add-trusted-cert; security "$operation" /tmp/fixture.pem',
    'tool=/usr/bin/security; "$tool" trust-settings-import /tmp/fixture.plist',
    'security help > "$HOME/Library/Preferences/com.apple.security.plist"',
  ])
    assert.equal(command(text).decision, 'deny', text);
});

test('read-only keychain metadata and ordinary project work remain available', () => {
  for (const text of [
    'security default-keychain -d user',
    'security list-keychains -d user',
    'security login-keychain -d user',
    'security default-keychain -duser',
    'security list-keychains -h',
    'security show-keychain-info',
    `security show-keychain-info '${profileHome}/Library/Keychains/cat-cafe.keychain-db'`,
    'security help',
    'security help add-certificates',
    'security -h',
    'security error -25300',
    'node --test project.test.mjs',
    'printf "security delete-keychain"',
    'printf ok > report.txt',
  ]) {
    assert.equal(command(text).decision, 'allow', text);
  }
});
