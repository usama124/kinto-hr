import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { assertSafeRuntimeRole, createDatabase } from '@kinto/database';
import { readConfig } from './config';
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly db = createDatabase(readConfig(process.env).databaseUrl);
  async onModuleInit() {
    await assertSafeRuntimeRole(this.db);
  }
  async ready() {
    await assertSafeRuntimeRole(this.db);
    await this.db.$queryRaw`SELECT 1`;
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
