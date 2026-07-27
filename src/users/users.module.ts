import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { DirectoryController } from './directory.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { InvitesModule } from '../invites/invites.module';

@Module({
  imports: [PrismaModule, AuditModule, InvitesModule],
  providers: [UsersService, MeService],
  controllers: [UsersController, MeController, DirectoryController],
  exports: [UsersService],
})
export class UsersModule {}
