import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  assertSafeRuntimeRole,
  createDatabase,
  findActiveIdentity,
  requestCompanyProvisioning,
} from '@kinto/database';
import {
  type AuthenticatedIdentity,
  type CompanyProvisioning,
} from '@kinto/contracts';
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
  provisionCompany(
    actor: { identityId: string; mfaVerified: boolean },
    requestKey: string,
    input: CompanyProvisioning,
  ) {
    return requestCompanyProvisioning(this.db, actor, requestKey, input);
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
