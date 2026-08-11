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
  let settings: any;
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
    // The email suffix and session timeout are settings now, not constants.
    settings = {
      get: jest.fn().mockResolvedValue('.gov.sl'),
      getNumber: jest.fn().mockResolvedValue(43200),
    };
    service = new AuthService(prisma, audit, settings);
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

  describe('the government-email gate', () => {
    it('refuses an ordinary user on a non-government address', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...staffOf({ active: true, name: 'Ministry of Health' }),
        email: 'someone@gmail.com',
        systemRole: 'STAFF',
      });

      await expect(signIn('someone@gmail.com')).rejects.toThrow(
        'Government email required',
      );
    });

    it('lets the super admin through on any address', async () => {
      // The single super admin is provisioned directly against the database,
      // belongs to no ministry, and is not a civil servant reachable at a
      // ministry domain. Enforcing the rule on that account locked the only
      // person who can administer the platform out of it.
      prisma.user.findUnique.mockResolvedValue({
        ...staffOf(null),
        email: 'someone@gmail.com',
        systemRole: 'SUPER_ADMIN',
      });

      // Gets past the domain gate to the password check, which is what matters.
      await expect(signIn('someone@gmail.com')).rejects.not.toThrow(
        'Government email required',
      );
    });

    it('still refuses an unknown address, so this cannot probe for accounts', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(signIn('stranger@gmail.com')).rejects.toThrow(
        'Government email required',
      );
    });
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

/**
 * getSession runs on every request, and used to return the user without asking
 * whether they were still allowed in. Deactivating someone, deactivating their
 * ministry and anonymising an account all left open sessions working — and
 * because the window slides forward on each request, an active user was never
 * ejected at all. These are the cases that were silently passing.
 */
describe('AuthService.getSession — revocation', () => {
  let prisma: any;
  let service: AuthService;

  const sessionFor = (overrides: Record<string, unknown>) => ({
    id: 'sess-1',
    token: 'tok',
    // Well in the future, so nothing here turns on expiry.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: {
      id: 'user-1',
      email: 'aminata@moh.gov.sl',
      name: 'Aminata',
      systemRole: 'STAFF',
      jobTitle: 'Director',
      ministryId: 'min-moh',
      active: true,
      deletedAt: null,
      ministry: { active: true },
      ...overrides,
    },
  });

  beforeEach(() => {
    prisma = {
      session: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new AuthService(
      prisma,
      { log: jest.fn() } as any,
      {
        get: jest.fn().mockResolvedValue('.gov.sl'),
        getNumber: jest.fn().mockResolvedValue(43200),
      } as any,
    );
  });

  it('returns the user when nothing is wrong', async () => {
    prisma.session.findUnique.mockResolvedValue(sessionFor({}));

    await expect(service.getSession('tok')).resolves.toMatchObject({
      id: 'user-1',
      ministryId: 'min-moh',
    });
  });

  it('refuses a deactivated user holding a live session', async () => {
    prisma.session.findUnique.mockResolvedValue(sessionFor({ active: false }));

    await expect(service.getSession('tok')).resolves.toBeNull();
  });

  it('refuses a soft-deleted user', async () => {
    prisma.session.findUnique.mockResolvedValue(
      sessionFor({ deletedAt: new Date() }),
    );

    await expect(service.getSession('tok')).resolves.toBeNull();
  });

  it('refuses a user whose ministry was deactivated under them', async () => {
    prisma.session.findUnique.mockResolvedValue(
      sessionFor({ ministry: { active: false } }),
    );

    await expect(service.getSession('tok')).resolves.toBeNull();
  });

  it('still admits a super admin, who has no ministry', async () => {
    prisma.session.findUnique.mockResolvedValue(
      sessionFor({
        systemRole: 'SUPER_ADMIN',
        ministryId: null,
        ministry: null,
      }),
    );

    await expect(service.getSession('tok')).resolves.toMatchObject({
      systemRole: 'SUPER_ADMIN',
    });
  });

  it('does not extend the window for a revoked session', async () => {
    // Expiring soon, so a healthy session here would be extended.
    const stale = sessionFor({ active: false });
    stale.expiresAt = new Date(Date.now() + 1000);
    prisma.session.findUnique.mockResolvedValue(stale);

    await service.getSession('tok');
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});
