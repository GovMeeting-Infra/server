import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient as BasePrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('PrismaService');
  private client: any;

  constructor() {
    this.logger.log('🔧 Initializing PrismaService...');
    const connectionString = process.env.DATABASE_URL || '';
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    try {
      const pool = new Pool({
        connectionString,
      });

      const adapter = new PrismaPg(pool);

      this.client = new (BasePrismaClient as any)({
        adapter: adapter,
      });

      this.logger.log('✅ Prisma client created');
    } catch (error) {
      this.logger.error('Failed to create Prisma client:', error);
      throw error;
    }

    // Forward anything this class doesn't define (model delegates such as
    // `event` and `eventAttendee`, plus `$transaction`/`$queryRaw`) straight
    // to the underlying client. This used to be a hand-maintained list of
    // getters, so any model missing from it — eventAttendee, qRToken,
    // eventCoOrganizer, eventSeries — blew up at runtime with a 500.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }

        const client = (target as any).client;
        if (!client) {
          throw new Error('Prisma client not initialized');
        }

        const value = client[prop];
        return typeof value === 'function' ? value.bind(client) : value;
      },
    });
  }

  async onModuleInit() {
    try {
      await this.client.$connect();
      this.logger.log('✅ Prisma connected to database');
    } catch (error) {
      this.logger.error('❌ Prisma connection failed:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      if (this.client) {
        await this.client.$disconnect();
      }
    } catch (error) {
      this.logger.error('❌ Prisma disconnect failed:', error);
    }
  }
}
