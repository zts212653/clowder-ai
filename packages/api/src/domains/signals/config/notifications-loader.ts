import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { SignalPaths } from './signal-paths.js';
import { resolveSignalPaths } from './signal-paths.js';
import { ensureSignalWorkspace } from './sources-loader.js';

const NOTIFICATIONS_FILE_BANNER = '# Clowder AI Signal Hunter notifications config\n';

const DailyDigestTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const NotificationSmtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  auth: z
    .object({
      user: z.string().min(1),
      pass: z.string().min(1),
    })
    .optional(),
});

const NotificationEmailSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['gmail', 'qq', 'outlook', 'custom']),
  smtp: NotificationSmtpSchema,
  to: z.string().email(),
  from: z.string().min(1),
});

const NotificationInAppSchema = z.object({
  enabled: z.boolean(),
  thread: z.string().min(1),
});

const NotificationSystemSchema = z.object({
  enabled: z.boolean(),
});

const NotificationScheduleSchema = z.object({
  daily_digest: DailyDigestTimeSchema,
  timezone: z.string().min(1),
});

export const SignalNotificationConfigSchema = z.object({
  version: z.literal(1),
  notifications: z.object({
    email: NotificationEmailSchema,
    in_app: NotificationInAppSchema,
    system: NotificationSystemSchema,
    schedule: NotificationScheduleSchema,
  }),
});

export type SignalNotificationConfig = z.infer<typeof SignalNotificationConfigSchema>;

export const DEFAULT_SIGNAL_NOTIFICATIONS: SignalNotificationConfig = {
  version: 1,
  notifications: {
    email: {
      enabled: false,
      provider: 'gmail',
      smtp: {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
      },
      to: 'owner@example.com',
      from: 'Clowder AI Signals <noreply@cat-cafe.local>',
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
};

function getNotificationsFilePath(paths: SignalPaths): string {
  return join(paths.configDir, 'notifications.yaml');
}

function toYaml(config: SignalNotificationConfig): string {
  return `${NOTIFICATIONS_FILE_BANNER}${stringify(config)}`;
}

async function writeDefaultNotificationsFile(paths: SignalPaths): Promise<void> {
  await writeFile(getNotificationsFilePath(paths), toYaml(DEFAULT_SIGNAL_NOTIFICATIONS), 'utf-8');
}

function parseAndValidateNotifications(yamlText: string): SignalNotificationConfig {
  const parsed = parse(yamlText) as unknown;
  const result = SignalNotificationConfigSchema.safeParse(parsed);

  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid signal notifications config: ${detail}`);
  }

  return result.data as SignalNotificationConfig;
}

export async function ensureSignalNotificationsFile(paths: SignalPaths = resolveSignalPaths()): Promise<void> {
  await ensureSignalWorkspace(paths);

  if (!existsSync(getNotificationsFilePath(paths))) {
    await writeDefaultNotificationsFile(paths);
  }
}

export async function loadSignalNotifications(
  paths: SignalPaths = resolveSignalPaths(),
): Promise<SignalNotificationConfig> {
  await ensureSignalNotificationsFile(paths);

  const notificationsFile = getNotificationsFilePath(paths);
  const yamlText = await readFile(notificationsFile, 'utf-8');

  if (yamlText.trim().length === 0) {
    await writeDefaultNotificationsFile(paths);
    return DEFAULT_SIGNAL_NOTIFICATIONS;
  }

  return parseAndValidateNotifications(yamlText);
}

export { resolveSignalPaths };
export type { SignalPaths };
