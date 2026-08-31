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
  reconcileCompanyOwnerProvider,
  markCompanyOwnerInvitationDelivered,
  requestEmployeeAccountProvisioning,
} from '@kinto/database';
import {
  type AuthenticatedIdentity,
  type CompanyProvisioning,
  type EmployeeAccountProvisioning,
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
  reconcileCompanyOwner(
    requestId: string,
    providerIdentity: { issuer: string; subject: string },
    expiresAt: Date,
  ) {
    return reconcileCompanyOwnerProvider(
      this.db,
      requestId,
      providerIdentity,
      expiresAt,
    );
  }
  markOwnerInvitationDelivered(requestId: string, expiresAt: Date) {
    return markCompanyOwnerInvitationDelivered(this.db, requestId, expiresAt);
  }
  provisionEmployeeAccount(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
    requestKey: string,
    input: EmployeeAccountProvisioning,
  ) {
    return requestEmployeeAccountProvisioning(
      this.db,
      actor,
      tenantId,
      employeeId,
      requestKey,
      input,
    );
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
