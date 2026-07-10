import { Logger } from '@nestjs/common';
import type { TenantDbService } from '../tenancy/tenant-db.service';
import type { MailService } from '../mail/mail.service';
import { NotificationsService, HandoverTarget } from './notifications.service';
import * as safeFetchModule from '../common/safe-fetch';

jest.mock('../common/safe-fetch', () => ({
  safeFetch: jest.fn(),
}));

const safeFetch = safeFetchModule.safeFetch as jest.MockedFunction<
  typeof safeFetchModule.safeFetch
>;

/**
 * Builds a NotificationsService whose `list()` resolves to the given targets,
 * with a fake MailService that records sends. `withTenant` is stubbed to run
 * the callback against a fake db that returns `rows` for any query — but
 * `notifyHandover` only calls `list()`, so we short-circuit by spying on it.
 */
function build(targets: HandoverTarget[]): {
  service: NotificationsService;
  mailSend: jest.MockedFunction<MailService['send']>;
} {
  const mailSend = jest.fn() as jest.MockedFunction<MailService['send']>;
  mailSend.mockResolvedValue(undefined);
  const tenantDb = {
    withTenant: jest.fn(),
  } as unknown as TenantDbService;
  const mail = { send: mailSend } as unknown as MailService;
  const service = new NotificationsService(tenantDb, mail);
  jest.spyOn(service, 'list').mockResolvedValue(targets);
  return { service, mailSend };
}

const event = {
  conversationId: 'c-1',
  reason: 'visitor asked for a human',
  afterHours: false,
  assignedAgentId: 'agent-9',
};

function target(kind: 'slack' | 'email', value: string): HandoverTarget {
  return {
    id: `id-${value}`,
    projectId: 'p-1',
    kind,
    target: value,
    createdAt: '2026-07-10T00:00:00Z',
  };
}

describe('NotificationsService.notifyHandover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    safeFetch.mockResolvedValue({ status: 200, body: 'ok', finalUrl: 'x' });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('does nothing when no targets are configured', async () => {
    const { service, mailSend } = build([]);
    await service.notifyHandover('t_' + '0'.repeat(32), 'p-1', event);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(mailSend).not.toHaveBeenCalled();
  });

  it('posts a Slack message body to the incoming-webhook URL', async () => {
    const { service } = build([
      target('slack', 'https://hooks.slack.example/T/B/X'),
    ]);
    await service.notifyHandover('t_' + '0'.repeat(32), 'p-1', event);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = safeFetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.example/T/B/X');
    expect(opts?.method).toBe('POST');
    const parsed = JSON.parse(opts?.body ?? '{}') as { text: string };
    expect(parsed.text).toContain('c-1');
    expect(parsed.text).toContain('visitor asked for a human');
    expect(parsed.text).toContain('agent-9');
  });

  it('sends an email to an email target via MailService', async () => {
    const { service, mailSend } = build([target('email', 'ops@acme.eu')]);
    await service.notifyHandover('t_' + '0'.repeat(32), 'p-1', event);
    expect(mailSend).toHaveBeenCalledTimes(1);
    const arg = mailSend.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(arg.to).toBe('ops@acme.eu');
    expect(arg.subject).toContain('c-1');
    expect(arg.text).toContain('visitor asked for a human');
  });

  it('mentions after-hours and unassigned state in the body', async () => {
    const { service } = build([
      target('slack', 'https://hooks.slack.example/z'),
    ]);
    await service.notifyHandover('t_' + '0'.repeat(32), 'p-1', {
      ...event,
      afterHours: true,
      assignedAgentId: null,
    });
    const parsed = JSON.parse(safeFetch.mock.calls[0][1]?.body ?? '{}') as {
      text: string;
    };
    expect(parsed.text).toContain('outside business hours');
    expect(parsed.text).toContain('unassigned');
  });

  it('fans out to every target and swallows one channel failing', async () => {
    safeFetch.mockRejectedValueOnce(new Error('slack down'));
    const { service, mailSend } = build([
      target('slack', 'https://hooks.slack.example/dead'),
      target('email', 'ops@acme.eu'),
    ]);
    await expect(
      service.notifyHandover('t_' + '0'.repeat(32), 'p-1', event),
    ).resolves.toBeUndefined();
    // The email still went out even though the Slack post threw.
    expect(mailSend).toHaveBeenCalledTimes(1);
  });

  it('never throws when email delivery fails', async () => {
    const { service, mailSend } = build([target('email', 'ops@acme.eu')]);
    mailSend.mockRejectedValueOnce(new Error('smtp down'));
    await expect(
      service.notifyHandover('t_' + '0'.repeat(32), 'p-1', event),
    ).resolves.toBeUndefined();
  });
});
