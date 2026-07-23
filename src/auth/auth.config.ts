import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { prismaAdapter } from 'better-auth/adapters/prisma';

let prisma: any;
try {
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
} catch {
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
    expiresIn: parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '1800', 10),
    updateAge: parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '1800', 10),
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
