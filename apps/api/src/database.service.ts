import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  assertSafeRuntimeRole,
  createDatabase,
  findActiveIdentity,
} from '@kinto/database';
import { type AuthenticatedIdentity } from '@kinto/contracts';
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
  findIdentity(principal: AuthenticatedIdentity) {
    return findActiveIdentity(this.db, principal);
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
