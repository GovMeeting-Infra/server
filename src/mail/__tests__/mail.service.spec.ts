import { MailService } from '../mail.service';
import type { EmailBody } from '../templates';

const BODY: EmailBody = {
  subject: 'Test subject',
  html: '<p>hi</p>',
  text: 'hi',
};

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

describe('MailService', () => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;
  const originalReplyTo = process.env.EMAIL_REPLY_TO;
  const originalSupport = process.env.SUPPORT_EMAIL;
  let fetchMock: jest.Mock;
  let service: MailService;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    service = new MailService();
  });

  afterAll(() => {
    process.env.RESEND_API_KEY = originalKey;
    process.env.EMAIL_FROM = originalFrom;
    process.env.EMAIL_REPLY_TO = originalReplyTo;
    process.env.SUPPORT_EMAIL = originalSupport;
  });

  describe('without an API key', () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = '';
    });

    it('reports itself unconfigured', () => {
      expect(service.isConfigured).toBe(false);
    });

    it('no-ops instead of throwing, so local dev is unaffected', async () => {
      await expect(service.send('a@b.gov.sl', BODY)).resolves.toEqual({
        sent: false,
        error: 'Email is not configured on this server',
      });
    });

    it('never touches the network', async () => {
      await service.send('a@b.gov.sl', BODY);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a whitespace-only key as absent', () => {
      process.env.RESEND_API_KEY = '   ';
      expect(new MailService().isConfigured).toBe(false);
    });
  });

  describe('with an API key', () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = 're_test_key';
      process.env.EMAIL_FROM = 'smartmeeting@calendar.gov.sl';
      process.env.EMAIL_REPLY_TO = '';
      process.env.SUPPORT_EMAIL = '';
    });

    const sentPayload = (): Record<string, string> => {
      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      return JSON.parse(init.body) as Record<string, string>;
    };

    it('reports success when Resend accepts the message', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await expect(service.send('a@b.gov.sl', BODY)).resolves.toEqual({
        sent: true,
      });
    });

    it('posts the recipient, sender, subject and both bodies', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await service.send('a@b.gov.sl', BODY);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer re_test_key');
      expect(JSON.parse(init.body)).toEqual({
        from: 'Smart Meeting <smartmeeting@calendar.gov.sl>',
        to: 'a@b.gov.sl',
        subject: 'Test subject',
        html: '<p>hi</p>',
        text: 'hi',
      });
    });

    it('keeps a display name EMAIL_FROM already carries', async () => {
      process.env.EMAIL_FROM = 'Ministry Meetings <meet@calendar.gov.sl>';
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await service.send('a@b.gov.sl', BODY);
      expect(sentPayload().from).toBe(
        'Ministry Meetings <meet@calendar.gov.sl>',
      );
    });

    it('sends as smartmeeting@ when EMAIL_FROM is unset', async () => {
      delete process.env.EMAIL_FROM;
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await service.send('a@b.gov.sl', BODY);
      expect(sentPayload().from).toBe(
        'Smart Meeting <smartmeeting@calendar.gov.sl>',
      );
    });

    it('omits reply_to when no reply address is configured', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await service.send('a@b.gov.sl', BODY);
      expect(sentPayload()).not.toHaveProperty('reply_to');
    });

    it('sends replies to SUPPORT_EMAIL when EMAIL_REPLY_TO is unset', async () => {
      process.env.SUPPORT_EMAIL = 'info@mocti.gov.sl';
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await service.send('a@b.gov.sl', BODY);
      expect(sentPayload().reply_to).toBe('info@mocti.gov.sl');
    });

    it('prefers EMAIL_REPLY_TO over SUPPORT_EMAIL', async () => {
      process.env.SUPPORT_EMAIL = 'info@mocti.gov.sl';
      process.env.EMAIL_REPLY_TO = 'meetings@mocti.gov.sl';
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
      await service.send('a@b.gov.sl', BODY);
      expect(sentPayload().reply_to).toBe('meetings@mocti.gov.sl');
    });

    it('reports the reason when the sender domain is unverified', async () => {
      // The single most likely production failure before DNS is configured.
      fetchMock.mockResolvedValue(
        jsonResponse(403, {
          message: 'The calendar.gov.sl domain is not verified',
        }),
      );
      await expect(service.send('a@b.gov.sl', BODY)).resolves.toEqual({
        sent: false,
        error: 'The calendar.gov.sl domain is not verified',
      });
    });

    it('falls back to the status code when the error body is unreadable', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(service.send('a@b.gov.sl', BODY)).resolves.toEqual({
        sent: false,
        error: 'Resend returned 500',
      });
    });

    it('swallows a network failure rather than propagating it', async () => {
      fetchMock.mockRejectedValue(new Error('socket hang up'));
      await expect(service.send('a@b.gov.sl', BODY)).resolves.toEqual({
        sent: false,
        error: 'socket hang up',
      });
    });
  });
});
