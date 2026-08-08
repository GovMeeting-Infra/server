// auth.config opens a database pool and throws without DATABASE_URL, both at
// module load. better-auth itself is ESM this jest setup cannot parse. Neither
// is under test here: these cases are decided before any password is checked.
jest.mock('../auth.config', () => ({
  auth: { api: { signInEmail: jest.fn() } },
}));
jest.mock('better-auth/api', () => ({
  APIError: class APIError extends Error {},
}));

import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';

/**
 * Deactivating a ministry is the supported alternative to deleting one, and it
 * only means anything if its users then cannot get in. Nothing enforced that
 * before, so the toggle was decorative.
 */
describe('AuthService.signIn — ministry status', () => {
  let prisma: any;
  let audit: any;
  let service: AuthService;

  const staffOf = (ministry: { active: boolean; name: string } | null) => ({
    id: 'user-1',
    email: 'aminata@moh.gov.sl',
    active: true,
    loginAttempts: 0,
    lockedUntil: null,
    ministryId: ministry ? 'min-moh' : null,
    ministry,
  });

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new AuthService(prisma, audit);
  });

  const signIn = (email = 'aminata@moh.gov.sl') =>
    service.signIn({ email, password: 'Password@123' } as any, '127.0.0.1');

  it('refuses a user whose ministry is deactivated', async () => {
    prisma.user.findUnique.mockResolvedValue(
      staffOf({ active: false, name: 'Ministry of Health' }),
    );

    await expect(signIn()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('gives no hint that the ministry, rather than the password, was the problem', async () => {
    prisma.user.findUnique.mockResolvedValue(
      staffOf({ active: false, name: 'Ministry of Health' }),
    );

    // Same text as a wrong password: whether an account exists, and the state
    // of its ministry, are not things to tell an unauthenticated caller.
    await expect(signIn()).rejects.toThrow('Invalid credentials');
  });

  it('records why in the audit log, where it is safe to say', async () => {
    prisma.user.findUnique.mockResolvedValue(
      staffOf({ active: false, name: 'Ministry of Health' }),
    );

    await expect(signIn()).rejects.toThrow();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN_FAILED',
        description: 'Ministry deactivated: Ministry of Health',
      }),
    );
  });

  it('lets a super admin in, having no ministry to deactivate', async () => {
    // Otherwise deactivating the wrong ministry could lock out the only role
    // able to reverse it.
    prisma.user.findUnique.mockResolvedValue(staffOf(null));

    // Gets past the ministry gate to the password check, which is mocked to
    // return nothing — a different failure, and that is the point.
    await expect(signIn('super@gov.sl')).rejects.toThrow();
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Ministry deactivated'),
      }),
    );
  });

  it('passes the ministry gate when the ministry is active', async () => {
    prisma.user.findUnique.mockResolvedValue(
      staffOf({ active: true, name: 'Ministry of Health' }),
    );

    await expect(signIn()).rejects.toThrow();
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Ministry deactivated'),
      }),
    );
  });
});
