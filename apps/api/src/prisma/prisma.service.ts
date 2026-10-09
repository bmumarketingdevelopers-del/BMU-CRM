import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { withChangeEvents } from '../platform/prisma-events.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    // v13: every write publishes a change event (live updates, search index). The extended client keeps the full
    // PrismaClient API, so the rest of the app is unchanged.
    const extended = withChangeEvents(this) as unknown as PrismaService;
    return extended;
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
