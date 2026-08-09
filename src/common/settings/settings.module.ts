import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';

// Global because AuthService reads the session timeout on every request and the
// email domain on every sign-in; threading this through each feature module
// would be noise.
@Global()
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
