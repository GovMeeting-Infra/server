import { Injectable, Logger } from '@nestjs/common';
import type { EmailBody } from './templates';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendResult {
  sent: boolean;
  error?: string;
}

/**
 * Outbound email via Resend's REST API.
 *
 * Deliberately does NOT use the `resend` npm SDK. That package depends on
 * @react-email/render, which requires `react-dom/server` — not installed in
 * this backend — so merely importing it crashes the application at startup.
 * The SDK buys nothing here either: these templates are plain HTML strings,
 * not React components. One fetch to a documented endpoint is the whole API.
 *
 * Two rules govern this class:
 *
 * 1. **It never throws.** Callers are creating accounts and running cron jobs;
 *    a mail outage, a missing key or an unverified sender domain must not fail
 *    the thing the user actually asked for. Every path returns a SendResult.
 * 2. **It no-ops without a key.** Local development and CI run with
 *    RESEND_API_KEY empty, and must behave exactly as before this existed.
 *
 * Reads process.env directly, matching the rest of the codebase — ConfigModule
 * is registered globally but no service injects ConfigService.
 */
@Injectable()
export class MailService {
  private logger = new Logger('MailService');

  private get apiKey(): string {
    return (process.env.RESEND_API_KEY || '').trim();
  }

  private get from(): string {
    return process.env.EMAIL_FROM || 'noreply@ministry.gov.sl';
  }

  /** Whether a send would actually be attempted. */
  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async send(to: string, body: EmailBody): Promise<SendResult> {
    if (!this.isConfigured) {
      this.logger.warn(
        `RESEND_API_KEY is not set — skipping "${body.subject}" to ${to}`,
      );
      return { sent: false, error: 'Email is not configured on this server' };
    }

    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to,
          subject: body.subject,
          html: body.html,
          text: body.text,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // The usual cause is an unverified sender domain, which Resend reports
        // as a 403 with a message rather than by failing the connection.
        const message =
          payload?.message || `Resend returned ${response.status}`;
        this.logger.error(
          `Resend rejected "${body.subject}" to ${to}: ${message}`,
        );
        return { sent: false, error: message };
      }

      this.logger.log(`Sent "${body.subject}" to ${to} (${payload?.id})`);
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown mail error';
      this.logger.error(`Failed sending "${body.subject}" to ${to}: ${message}`);
      return { sent: false, error: message };
    }
  }
}
