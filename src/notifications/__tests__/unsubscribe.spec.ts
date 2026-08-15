import { BadRequestException } from '@nestjs/common';
import { UnsubscribeController } from '../unsubscribe.controller';
import {
  signEmail,
  verifyEmail,
  digestUnsubscribeUrl,
  DIGEST_KIND,
} from '../unsubscribe.util';

/**
 * The link is the credential, so the signature is the whole security story:
 * without it, anyone holding one unsubscribe link could edit the address in it
 * and silence somebody else's weekly summary.
 */
describe('unsubscribe signing', () => {
  const EMAIL = 'aminata@moh.gov.sl';

  it('accepts its own signature', () => {
    expect(verifyEmail(EMAIL, signEmail(EMAIL))).toBe(true);
  });

  it('refuses a signature made for a different address', () => {
    expect(verifyEmail('someone.else@moh.gov.sl', signEmail(EMAIL))).toBe(false);
  });

  it('refuses a tampered signature', () => {
    const token = signEmail(EMAIL);
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyEmail(EMAIL, tampered)).toBe(false);
  });

  it('refuses an absent or empty token without throwing', () => {
    expect(verifyEmail(EMAIL, '')).toBe(false);
    expect(verifyEmail(EMAIL, undefined as unknown as string)).toBe(false);
  });

  // Addresses are stored and compared lowercased, so the same person typed two
  // ways is one person.
  it('treats casing and surrounding space as the same address', () => {
    expect(verifyEmail(`  ${EMAIL.toUpperCase()} `, signEmail(EMAIL))).toBe(
      true,
    );
  });

  it('builds a link carrying both the address and its signature', () => {
    const url = new URL(digestUnsubscribeUrl(EMAIL));
    expect(url.pathname).toBe('/unsubscribe');
    expect(url.searchParams.get('email')).toBe(EMAIL);
    expect(
      verifyEmail(EMAIL, url.searchParams.get('token') as string),
    ).toBe(true);
  });
});

describe('UnsubscribeController', () => {
  const EMAIL = 'aminata@moh.gov.sl';
  let prisma: any;
  let controller: UnsubscribeController;

  beforeEach(() => {
    prisma = {
      emailSuppression: { upsert: jest.fn().mockResolvedValue({}) },
    };
    controller = new UnsubscribeController(prisma);
  });

  it('suppresses the address when the signature checks out', async () => {
    await controller.unsubscribeDigest({
      email: EMAIL,
      token: signEmail(EMAIL),
    });

    expect(prisma.emailSuppression.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { email: EMAIL, kind: DIGEST_KIND },
      }),
    );
  });

  it('refuses a link edited to name someone else', async () => {
    await expect(
      controller.unsubscribeDigest({
        email: 'someone.else@moh.gov.sl',
        token: signEmail(EMAIL),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.emailSuppression.upsert).not.toHaveBeenCalled();
  });

  // A one-click header may well be fired more than once, and unsubscribing
  // twice is the same fact.
  it('is safe to call twice', async () => {
    const body = { email: EMAIL, token: signEmail(EMAIL) };
    await controller.unsubscribeDigest(body);
    await controller.unsubscribeDigest(body);
    expect(prisma.emailSuppression.upsert).toHaveBeenCalledTimes(2);
  });
});
