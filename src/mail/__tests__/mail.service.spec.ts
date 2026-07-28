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
      process.env.EMAIL_FROM = 'noreply@ministry.gov.sl';
    });

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
        from: 'noreply@ministry.gov.sl',
        to: 'a@b.gov.sl',
        subject: 'Test subject',
        html: '<p>hi</p>',
        text: 'hi',
      });
    });

    it('reports the reason when the sender domain is unverified', async () => {
      // The single most likely production failure before DNS is configured.
      fetchMock.mockResolvedValue(
        jsonResponse(403, {
          message: 'The ministry.gov.sl domain is not verified',
        }),
      );
      await expect(service.send('a@b.gov.sl', BODY)).resolves.toEqual({
        sent: false,
        error: 'The ministry.gov.sl domain is not verified',
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
