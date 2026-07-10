import { Logger } from '@nestjs/common';
import { AppConfig } from '../config/config';
import { MailService } from './mail.service';

function baseCfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'unused',
    dbStatementTimeoutMs: 30_000,
    dbIdleTxTimeoutMs: 30_000,
    port: 0,
    nodeEnv: 'test',
    oidcIssuer: 'https://id.example.eu',
    oidcAudience: 'bonsai-api',
    oidcJwksUrl: 'https://id.example.eu/keys',
    embeddingDim: 1024,
    rateLimitPerMinute: 120,
    widgetConfigRatePerMin: 60,
    conversationStartRatePerMin: 20,
    transcriptEmailRatePerMin: 5,
    recrawlIntervalMs: 86_400_000,
    ingestionStaleMs: 900_000,
    ingestionTimeoutMs: 60_000,
    s3Region: 'us-east-1',
    selfCheckEnabled: true,
    verificationMode: 'self-check',
    multiQueryEnabled: true,
    retrievalWindow: 1,
    billingEnabled: false,
    widgetCorsOrigins: [],
    answerCacheEnabled: true,
    answerCacheTtlMs: 3_600_000,
    followupSuggestionsEnabled: true,
    toolCallingEnabled: true,
    dedupEnabled: true,
    nearDupThreshold: 0.97,
    frustrationAutoEscalateEnabled: true,
    frustrationRefusalStreak: 2,
    smtpPort: 587,
    smtpSecure: false,
    ...overrides,
  };
}

describe('MailService', () => {
  it('is a no-op (does not throw, does not create a transport) when SMTP_HOST is unset', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const service = new MailService(baseCfg());
    await expect(
      service.send({ to: 'user@example.eu', subject: 'Hi', text: 'Hello' }),
    ).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('sends via nodemailer transport when SMTP_HOST is configured', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'abc' });
    const service = new MailService(
      baseCfg({
        smtpHost: 'smtp.example.eu',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'pass',
        smtpFrom: 'noreply@example.eu',
        smtpSecure: false,
      }),
    );
    // Inject a fake transporter to avoid a real network connection.
    (
      service as unknown as { transporter: { sendMail: typeof sendMail } }
    ).transporter = { sendMail };

    await service.send({
      to: 'user@example.eu',
      subject: 'Hi',
      html: '<p>Hello</p>',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.eu',
        subject: 'Hi',
        html: '<p>Hello</p>',
        from: 'noreply@example.eu',
      }),
    );
  });
});
