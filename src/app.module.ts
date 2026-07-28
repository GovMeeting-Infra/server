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
import { CacheModule } from './cache/cache.module';
import { EventsModule } from './events/events.module';
import { AttendanceModule } from './attendance/attendance.module';
import { MinutesModule } from './minutes/minutes.module';
import { RoomsModule } from './rooms/rooms.module';
import { ReportsModule } from './reports/reports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthModule } from './health/health.module';
import { UploadsModule } from './uploads/uploads.module';
import { SearchModule } from './search/search.module';
import { InvitesModule } from './invites/invites.module';
import { SessionMiddleware } from './auth/middleware/session.middleware';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host:
          process.env.REDIS_URL?.split('//')[1]?.split(':')[0] || 'localhost',
        port: parseInt(process.env.REDIS_URL?.split(':')?.pop() || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullModule.registerQueue(
      { name: 'email-queue' },
      { name: 'notification-queue' },
    ),
    PrismaModule,
    AuditModule,
    AuthModule,
    MinistriesModule,
    UsersModule,
    CacheModule,
    EventsModule,
    AttendanceModule,
    MinutesModule,
    RoomsModule,
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
