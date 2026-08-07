// Must come first. Everything below runs at module load, which is when
// AppModule is imported — before NestFactory.create() gets as far as
// ConfigModule.forRoot() and reads .env. Without this, DATABASE_URL was empty
// here and BetterAuth quietly built its pool against localhost, so on a server
// with no local Postgres every sign-in failed with DatabaseNotReachable
// 127.0.0.1:5432 while the app's own PrismaService — a provider, constructed
// later — reported a healthy connection to Neon.
import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Fail at boot rather than at the first sign-in. The old fallback to a local
  // development database turned a missing variable into a 400 at login with
  // nothing in the response to explain it.
  throw new Error(
    'DATABASE_URL is not set — BetterAuth cannot reach the database.',
  );
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma: any = new (PrismaClient as any)({ adapter });

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
    expiresIn: parseInt(
      process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '43200',
      10,
    ),
    updateAge: parseInt(
      process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '43200',
      10,
    ),
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
