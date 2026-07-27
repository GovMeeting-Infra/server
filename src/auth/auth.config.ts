import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client';

let prisma: any;
try {
  const connectionString = process.env.DATABASE_URL || 'postgresql://govmeeting:devpass@localhost:5432/govmeeting_dev';
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  prisma = new (PrismaClient as any)({ adapter });
} catch (error) {
  console.error('Failed to initialize Prisma for BetterAuth:', error);
  prisma = null;
}

export const auth: any = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  appName: 'GovMeeting',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  basePath: '/auth',
  trustedOrigins: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean),
  advanced: {
    database: {
      generateId: false,
    },
    crossSubDomainCookies: {
      enabled: !!process.env.COOKIE_DOMAIN,
      domain: process.env.COOKIE_DOMAIN,
    },
    defaultCookieAttributes: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  },
  session: {
    // Used only when better-auth first creates the row at sign-in. The sliding
    // extension afterwards is ours, in AuthService.getSession — better-auth's
    // own session route is never called, so updateAge below has no effect and
    // is kept only to mirror expiresIn.
    expiresIn: parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '43200', 10),
    updateAge: parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '43200', 10),
  },
  emailAndPassword: {
    enabled: true,
  },
  plugins: [admin()],
  user: {
    additionalFields: {
      jobTitle: {
        type: 'string',
        input: false,
      },
      systemRole: {
        type: 'string',
        input: false,
        defaultValue: 'STAFF',
      },
      ministryId: {
        type: 'string',
        required: false,
        input: false,
      },
      active: {
        type: 'boolean',
        input: false,
        defaultValue: true,
      },
      loginAttempts: {
        type: 'number',
        input: false,
        defaultValue: 0,
      },
      lockedUntil: {
        type: 'date',
        required: false,
        input: false,
      },
    },
  },
});
