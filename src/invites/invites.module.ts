import { Module } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { InvitesController } from './invites.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [PrismaModule, AuditModule, MailModule],
  providers: [InvitesService],
  controllers: [InvitesController],
  exports: [InvitesService],
})
export class InvitesModule {}
