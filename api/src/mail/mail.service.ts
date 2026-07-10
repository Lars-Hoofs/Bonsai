import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: MailAttachment[];
}

/**
 * Thin self-hosted-SMTP mail foundation (free — no paid email provider),
 * used by team invitations and later features.
 *
 * When SMTP_HOST is unset (the default in dev/test), `send` is a no-op that
 * only logs at debug level, so no real mail is ever sent outside of a
 * configured deployment. When SMTP_HOST is set, a nodemailer transport is
 * built once at construction and reused for every send.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter?: Transporter;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    if (cfg.smtpHost) {
      this.transporter = createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure,
        auth:
          cfg.smtpUser && cfg.smtpPass
            ? { user: cfg.smtpUser, pass: cfg.smtpPass }
            : undefined,
      });
    }
    this.from = cfg.smtpFrom ?? 'no-reply@bonsai.local';
  }

  async send(input: SendMailInput): Promise<void> {
    if (!this.transporter) {
      this.logger.debug(
        `Mail not configured (SMTP_HOST unset) — skipping send to ${input.to}: "${input.subject}"`,
      );
      return;
    }
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments: input.attachments,
    });
  }
}
