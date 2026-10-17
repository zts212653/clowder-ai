import { createRetryableLoader } from '../../../utils/retryable-loader.js';
import type { SignalNotificationConfig } from '../config/notifications-loader.js';

const loadNodemailer = createRetryableLoader(async () => (await import('nodemailer')).default);

export interface DailyDigestMessage {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailSendResult {
  readonly status: 'sent' | 'skipped' | 'error';
  readonly messageId?: string | undefined;
  readonly error?: string | undefined;
}

export interface EmailTransportInput {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailTransporter {
  sendMail(input: EmailTransportInput): Promise<{ messageId?: string | undefined }>;
}

export type EmailTransporterFactory = (
  smtpConfig: SignalNotificationConfig['notifications']['email']['smtp'],
) => EmailTransporter;

export interface SignalEmailServiceOptions {
  readonly config: SignalNotificationConfig;
  readonly createTransporter?: EmailTransporterFactory | undefined;
}

function defaultCreateTransporter(
  smtpConfig: SignalNotificationConfig['notifications']['email']['smtp'],
): EmailTransporter {
  const loadTransporter = createRetryableLoader(async () => {
    const nodemailer = await loadNodemailer();
    return nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      ...(smtpConfig.auth ? { auth: smtpConfig.auth } : {}),
    });
  });

  return {
    async sendMail(input: EmailTransportInput): Promise<{ messageId?: string | undefined }> {
      const transporter = await loadTransporter();
      const result = await transporter.sendMail(input);
      return {
        ...(result.messageId ? { messageId: result.messageId } : {}),
      };
    },
  };
}

export class SignalEmailService {
  private readonly config: SignalNotificationConfig;
  private readonly createTransporter: EmailTransporterFactory;
  private transporter: EmailTransporter | undefined;

  constructor(options: SignalEmailServiceOptions) {
    this.config = options.config;
    this.createTransporter = options.createTransporter ?? defaultCreateTransporter;
  }

  async sendDailyDigest(message: DailyDigestMessage): Promise<EmailSendResult> {
    const emailConfig = this.config.notifications.email;

    if (!emailConfig.enabled) {
      return { status: 'skipped' };
    }

    try {
      const transporter = this.transporter ?? this.createTransporter(emailConfig.smtp);
      this.transporter = transporter;

      const result = await transporter.sendMail({
        from: emailConfig.from,
        to: emailConfig.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      return {
        status: 'sent',
        ...(result.messageId ? { messageId: result.messageId } : {}),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: 'error',
        error: detail,
      };
    }
  }
}
