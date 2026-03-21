import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { SignalEmailService } = await import('../dist/domains/signals/services/email-service.js');

function createNotificationsConfig(overrides = {}) {
  return {
    version: 1,
    notifications: {
      email: {
        enabled: true,
        provider: 'gmail',
        smtp: {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: 'cat-cafe@example.com',
            pass: 'app-password',
          },
        },
        to: 'owner@example.com',
        from: 'Cat Cafe Signals <noreply@example.com>',
      },
      in_app: {
        enabled: true,
        thread: 'signals',
      },
      system: {
        enabled: false,
      },
      schedule: {
        daily_digest: '08:00',
        timezone: 'Asia/Shanghai',
      },
    },
    ...overrides,
  };
}

describe('signal email service', () => {
  it('returns skipped when email notification is disabled', async () => {
    let transporterCreated = false;
    const service = new SignalEmailService({
      config: createNotificationsConfig({
        notifications: {
          ...createNotificationsConfig().notifications,
          email: {
            ...createNotificationsConfig().notifications.email,
            enabled: false,
          },
        },
      }),
      createTransporter: () => {
        transporterCreated = true;
        return {
          async sendMail() {
            return { messageId: 'never-used' };
          },
        };
      },
    });

    const result = await service.sendDailyDigest({
      subject: 'Digest',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    assert.equal(result.status, 'skipped');
    assert.equal(transporterCreated, false);
  });

  it('sends digest email via injected transporter', async () => {
    const sendMailCalls = [];

    const service = new SignalEmailService({
      config: createNotificationsConfig(),
      createTransporter: () => ({
        async sendMail(payload) {
          sendMailCalls.push(payload);
          return { messageId: 'msg_123' };
        },
      }),
    });

    const result = await service.sendDailyDigest({
      subject: '🐱 Clowder AI 信号日报 - 2026-02-19',
      html: '<h1>Digest</h1>',
      text: 'Digest',
    });

    assert.equal(result.status, 'sent');
    assert.equal(result.messageId, 'msg_123');
    assert.equal(sendMailCalls.length, 1);
    assert.equal(sendMailCalls[0].from, 'Cat Cafe Signals <noreply@example.com>');
    assert.equal(sendMailCalls[0].to, 'owner@example.com');
    assert.equal(sendMailCalls[0].subject, '🐱 Clowder AI 信号日报 - 2026-02-19');
    assert.equal(sendMailCalls[0].html, '<h1>Digest</h1>');
    assert.equal(sendMailCalls[0].text, 'Digest');
  });

  it('returns structured error when transporter send fails', async () => {
    const service = new SignalEmailService({
      config: createNotificationsConfig(),
      createTransporter: () => ({
        async sendMail() {
          throw new Error('smtp timeout');
        },
      }),
    });

    const result = await service.sendDailyDigest({
      subject: 'Digest',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /smtp timeout/);
  });
});
