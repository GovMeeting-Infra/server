import { Module, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { MinistriesModule } from './ministries/ministries.module';
import { UsersModule } from './users/users.module';
import { PlatformModule } from './platform/platform.module';
import { CacheModule } from './cache/cache.module';
import { EventsModule } from './events/events.module';
import { AttendanceModule } from './attendance/attendance.module';
import { MinutesModule } from './minutes/minutes.module';
import { ReportsModule } from './reports/reports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthModule } from './health/health.module';
import { UploadsModule } from './uploads/uploads.module';
import { SearchModule } from './search/search.module';
import { InvitesModule } from './invites/invites.module';
import { SessionMiddleware } from './auth/middleware/session.middleware';
import { redisConnectionOptions } from './common/utils/redis-connection.util';
import { SettingsModule } from './common/settings/settings.module';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: redisConnectionOptions(),
      // Without these, BullMQ's default of one attempt applies and a job that
      // throws is gone — a Resend blip at 08:00 silently lost that morning's
      // reminders, and three comments in the processor claimed otherwise.
      // Three tries over roughly a minute covers a transient failure without
      // hammering an API that is already refusing us.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    }),
    // 'notification-queue' was registered here too but had no processor and no
    // producer. In-app notifications are written straight to the database.
    BullModule.registerQueue({ name: 'email-queue' }),
    PrismaModule,
    PlatformModule,
    // Global: AuthService reads the session timeout on every request.
    SettingsModule,
    AuditModule,
    AuthModule,
    MinistriesModule,
    UsersModule,
    CacheModule,
    EventsModule,
    AttendanceModule,
    MinutesModule,
    ReportsModule,
    NotificationsModule,
    HealthModule,
    UploadsModule,
    SearchModule,
    InvitesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Attaches req.user from the session cookie for every route. Guards still
    // decide access; this only makes the authenticated user available to them.
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}
