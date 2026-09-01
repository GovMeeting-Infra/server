/**
 * Appoints a platform administrator.
 *
 * The same thing the owner does at /administrative/admin/users, for a machine
 * where nobody can sign in — a fresh deployment, or the box being the reason
 * you need an engineer in the first place.
 *
 *   npx ts-node -r dotenv/config scripts/create-platform-admin.ts \
 *     --email ops.engineer@mocti.gov.sl --name "Ops Engineer" [--job-title "..."]
 *
 * It goes through UsersService rather than writing rows, so every rule applies:
 * the address must be a government one, the account is filed under no ministry,
 * an invitation is issued, and the appointment is written to the audit log
 * against the owner who authorised it. Nobody, including this script, ever
 * handles a password — the invitation link is how one gets set.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { UsersService } from '../src/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const email = arg('email')?.toLowerCase().trim();
  const name = arg('name');
  const jobTitle = arg('job-title') ?? 'Platform Engineer';

  if (!email || !name) {
    console.error(
      'Usage: --email <address> --name "<full name>" [--job-title "<title>"]',
    );
    process.exit(1);
  }

  // Quiet: this is a script, and Nest's boot banner is longer than its output.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const users = app.get(UsersService);
    const prisma = app.get(PrismaService) as any;

    // Appointing a platform admin is the owner's act, so the audit row must
    // name a real owner rather than a placeholder. If there is none, that is
    // the finding — refuse instead of filing the appointment against nobody.
    const owner = await prisma.user.findFirst({
      where: { systemRole: 'SUPER_ADMIN', deletedAt: null },
      select: { id: true, email: true },
    });

    if (!owner) {
      throw new Error(
        'No platform owner exists to authorise this. Provision one first.',
      );
    }

    const created = await users.create(
      { email, name, jobTitle, systemRole: 'PLATFORM_ADMIN' } as any,
      owner.id,
      undefined,
      'SUPER_ADMIN',
    );

    console.log(`\nAppointed ${created.name} <${created.email}>`);
    console.log(`  role      : ${created.systemRole}`);
    console.log(`  ministry  : none, by design`);
    console.log(`  authorised: ${owner.email}`);
    console.log(
      `\nThey set their own password from this link, valid 7 days:\n  ${
        (created.invite as any)?.link ?? '(the invitation email carries it)'
      }\n`,
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
