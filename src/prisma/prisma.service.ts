import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

let PrismaClientClass: any;

try {
  ({ PrismaClient: PrismaClientClass } = require('.prisma/client'));
} catch {
  try {
    ({ PrismaClient: PrismaClientClass } = require('@prisma/client'));
  } catch {
    PrismaClientClass = class PrismaClient {};
  }
}

@Injectable()
export class PrismaService extends PrismaClientClass implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('PrismaService');

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    const pool = new Pool({
      connectionString,
    });

    const adapter = new PrismaPg(pool);

    super({
      adapter,
    });
  }

  async onModuleInit() {
    try {
      await (this as any).$connect();
      this.logger.log('✅ Prisma connected');
    } catch (error) {
      this.logger.error('❌ Prisma connection failed:', error);
    }
  }

  async onModuleDestroy() {
    await (this as any).$disconnect();
  }
}
