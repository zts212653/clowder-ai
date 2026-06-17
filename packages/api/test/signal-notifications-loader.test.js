import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const modulePath = '../dist/domains/signals/config/notifications-loader.js';

describe('signal notifications loader', () => {
  let tempRoot;
  let prevSignalsRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync('/tmp/cat-cafe-signal-notifications-');
    prevSignalsRoot = process.env.SIGNALS_ROOT_DIR;
    process.env.SIGNALS_ROOT_DIR = tempRoot;
  });

  afterEach(() => {
    if (prevSignalsRoot === undefined) {
      delete process.env.SIGNALS_ROOT_DIR;
    } else {
      process.env.SIGNALS_ROOT_DIR = prevSignalsRoot;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes default notifications.yaml when file is missing', async () => {
    const { loadSignalNotifications, resolveSignalPaths } = await import(modulePath);

    const paths = resolveSignalPaths();
    const config = await loadSignalNotifications(paths);

    const notificationsFile = join(paths.configDir, 'notifications.yaml');
    assert.equal(existsSync(notificationsFile), true);
    assert.equal(config.version, 1);
    assert.equal(config.notifications.email.enabled, false);
    assert.equal(config.notifications.in_app.enabled, true);
  });

  it('parses valid notifications yaml', async () => {
    const { ensureSignalNotificationsFile, loadSignalNotifications, resolveSignalPaths } = await import(modulePath);

    const paths = resolveSignalPaths();
    const notificationsFile = join(paths.configDir, 'notifications.yaml');
    await ensureSignalNotificationsFile(paths);

    writeFileSync(
      notificationsFile,
      `version: 1\nnotifications:\n  email:\n    enabled: true\n    provider: gmail\n    smtp:\n      host: smtp.gmail.com\n      port: 587\n      secure: false\n      auth:\n        user: cat-cafe@example.com\n        pass: app-password\n    to: owner@example.com\n    from: Clowder AI <noreply@example.com>\n  in_app:\n    enabled: true\n    thread: signals\n  system:\n    enabled: false\n  schedule:\n    daily_digest: "08:00"\n    timezone: Asia/Shanghai\n`,
      'utf-8',
    );

    const config = await loadSignalNotifications(paths);

    assert.equal(config.notifications.email.enabled, true);
    assert.equal(config.notifications.email.provider, 'gmail');
    assert.equal(config.notifications.schedule.daily_digest, '08:00');
    assert.equal(config.notifications.in_app.thread, 'signals');
  });

  it('throws schema error with field path for invalid config', async () => {
    const { ensureSignalNotificationsFile, loadSignalNotifications, resolveSignalPaths } = await import(modulePath);

    const paths = resolveSignalPaths();
    const notificationsFile = join(paths.configDir, 'notifications.yaml');
    await ensureSignalNotificationsFile(paths);

    writeFileSync(
      notificationsFile,
      `version: 1\nnotifications:\n  email:\n    enabled: true\n    provider: gmail\n    smtp:\n      host: smtp.gmail.com\n      port: 587\n      secure: false\n    to: not-an-email\n    from: Clowder AI <noreply@example.com>\n  in_app:\n    enabled: true\n    thread: signals\n  system:\n    enabled: false\n  schedule:\n    daily_digest: "08:00"\n    timezone: Asia/Shanghai\n`,
      'utf-8',
    );

    await assert.rejects(
      async () => {
        await loadSignalNotifications(paths);
      },
      (error) => {
        assert.match(String(error), /notifications\.email\.to/);
        return true;
      },
    );
  });
});
