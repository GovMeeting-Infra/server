import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient as BasePrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('PrismaService');
  private client: any;

  constructor() {
    console.log('[PrismaService] 🔧 Initializing PrismaService...');
    this.logger.log('🔧 Initializing PrismaService...');
    const connectionString = process.env.DATABASE_URL || '';
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    try {
      console.log('[PrismaService] 📦 Creating Pool...');
      this.logger.log('📦 Creating Pool...');
      const pool = new Pool({
        connectionString,
      });

      console.log('[PrismaService] 🔌 Creating PrismaPg adapter...');
      this.logger.log('🔌 Creating PrismaPg adapter...');
      const adapter = new PrismaPg(pool);

      console.log('[PrismaService] 🚀 Instantiating PrismaClient...');
      this.logger.log('🚀 Instantiating PrismaClient...');
      this.client = new (BasePrismaClient as any)({
        adapter: adapter,
      });

      console.log('[PrismaService] ✅ Prisma client created');
      this.logger.log('✅ Prisma client created');
    } catch (error) {
      console.error('[PrismaService] Failed to create Prisma client:', error);
      this.logger.error('Failed to create Prisma client:', error);
      throw error;
    }
  }

  // Proxy all property access to the Prisma client
  get user() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.user;
  }

  get session() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.session;
  }

  get account() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.account;
  }

  get verification() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.verification;
  }

  get ministry() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.ministry;
  }

  get room() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.room;
  }

  get event() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.event;
  }

  get attendance() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.attendance;
  }

  get minutes() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.minutes;
  }

  get actionItem() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.actionItem;
  }

  get auditLog() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.auditLog;
  }

  get notification() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.notification;
  }

  get userPreferences() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.userPreferences;
  }

  get roomBooking() {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.roomBooking;
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
