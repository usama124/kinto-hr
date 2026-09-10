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
  reconcileEmployeeAccountProvider,
  markEmployeeInvitationDelivered,
  listTenantMemberships,
  updateTenantMembershipRoles,
  revokeTenantMembership,
  requestAdministratorInvitation,
  reconcileAdministratorInvitationProvider,
  markAdministratorInvitationDelivered,
  discoverIdentityTenants,
  listTenantSecurityAudit,
  readTenantOrganization,
  createTenantLegalEntity,
  updateTenantLegalEntity,
  createTenantBranch,
  updateTenantBranch,
  createTenantOrganizationCatalogEntry,
  updateTenantOrganizationCatalogEntry,
  createOrganizationPolicyDraft,
  previewOrganizationPolicy,
  publishOrganizationPolicy,
  readTenantEntitlements,
  previewEntitlementChange,
  createEntitlementChange,
  revokeEntitlementChange,
  readTenantEmployees,
  readTenantEmployee,
  createTenantEmployee,
  updateTenantEmployeeProfile,
  createTenantEmployeeAssignment,
  activateTenantEmployee,
  scheduleTenantEmployeeTermination,
  archiveTenantEmployee,
} from '@kinto/database';
import {
  type AuthenticatedIdentity,
  type CompanyProvisioning,
  type EmployeeAccountProvisioning,
  type MembershipRoleUpdate,
  type MembershipRevocation,
  type AdministratorInvitation,
  type SecurityAuditQuery,
  type LegalEntityCreate,
  type LegalEntityUpdate,
  type BranchCreate,
  type BranchUpdate,
  type OrganizationCatalogCreate,
  type OrganizationCatalogUpdate,
  type OrganizationPolicyDraft,
  type OrganizationPolicyPublish,
  type EntitlementChange,
  type EntitlementRevocation,
  type EmployeeRecordCreate,
  type EmployeeProfileUpdate,
  type EmployeeAssignmentCreate,
  type EmployeeActivation,
  type EmployeeTermination,
  type EmployeeArchive,
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
  discoverTenants(identityId: string) {
    return discoverIdentityTenants(this.db, identityId);
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
  reconcileEmployeeAccount(
    requestId: string,
    providerIdentity: { issuer: string; subject: string },
    expiresAt: Date,
  ) {
    return reconcileEmployeeAccountProvider(
      this.db,
      requestId,
      providerIdentity,
      expiresAt,
    );
  }
  markEmployeeInvitationDelivered(requestId: string, expiresAt: Date) {
    return markEmployeeInvitationDelivered(this.db, requestId, expiresAt);
  }
  provisionAdministrator(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    requestKey: string,
    input: AdministratorInvitation,
  ) {
    return requestAdministratorInvitation(
      this.db,
      actor,
      tenantId,
      requestKey,
      input,
    );
  }
  reconcileAdministrator(
    requestId: string,
    providerIdentity: { issuer: string; subject: string },
    expiresAt: Date,
  ) {
    return reconcileAdministratorInvitationProvider(
      this.db,
      requestId,
      providerIdentity,
      expiresAt,
    );
  }
  markAdministratorInvitationDelivered(requestId: string, expiresAt: Date) {
    return markAdministratorInvitationDelivered(this.db, requestId, expiresAt);
  }
  listMemberships(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
  ) {
    return listTenantMemberships(this.db, actor, tenantId);
  }
  updateMembershipRoles(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    membershipId: string,
    input: MembershipRoleUpdate,
  ) {
    return updateTenantMembershipRoles(
      this.db,
      actor,
      tenantId,
      membershipId,
      input,
    );
  }
  revokeMembership(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    membershipId: string,
    input: MembershipRevocation,
  ) {
    return revokeTenantMembership(
      this.db,
      actor,
      tenantId,
      membershipId,
      input,
    );
  }
  listSecurityAudit(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    query: SecurityAuditQuery,
  ) {
    return listTenantSecurityAudit(this.db, actor, tenantId, query);
  }
  readOrganization(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
  ) {
    return readTenantOrganization(this.db, actor, tenantId);
  }
  createLegalEntity(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    input: LegalEntityCreate,
  ) {
    return createTenantLegalEntity(this.db, actor, tenantId, input);
  }
  updateLegalEntity(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    entityId: string,
    input: LegalEntityUpdate,
  ) {
    return updateTenantLegalEntity(this.db, actor, tenantId, entityId, input);
  }
  createBranch(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    input: BranchCreate,
  ) {
    return createTenantBranch(this.db, actor, tenantId, input);
  }
  updateBranch(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    branchId: string,
    input: BranchUpdate,
  ) {
    return updateTenantBranch(this.db, actor, tenantId, branchId, input);
  }
  createOrganizationCatalogEntry(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    catalog: 'department' | 'designation',
    input: OrganizationCatalogCreate,
  ) {
    return createTenantOrganizationCatalogEntry(
      this.db,
      actor,
      tenantId,
      catalog,
      input,
    );
  }
  updateOrganizationCatalogEntry(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    catalog: 'department' | 'designation',
    resourceId: string,
    input: OrganizationCatalogUpdate,
  ) {
    return updateTenantOrganizationCatalogEntry(
      this.db,
      actor,
      tenantId,
      catalog,
      resourceId,
      input,
    );
  }
  createPolicyDraft(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    input: OrganizationPolicyDraft,
  ) {
    return createOrganizationPolicyDraft(this.db, actor, tenantId, input);
  }
  previewPolicy(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    policyId: string,
  ) {
    return previewOrganizationPolicy(this.db, actor, tenantId, policyId);
  }
  publishPolicy(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    policyId: string,
    input: OrganizationPolicyPublish,
  ) {
    return publishOrganizationPolicy(this.db, actor, tenantId, policyId, input);
  }
  readEntitlements(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
  ) {
    return readTenantEntitlements(this.db, actor, tenantId);
  }
  previewEntitlementChange(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    input: EntitlementChange,
  ) {
    return previewEntitlementChange(this.db, actor, tenantId, input);
  }
  createEntitlementChange(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    input: EntitlementChange,
  ) {
    return createEntitlementChange(this.db, actor, tenantId, input);
  }
  revokeEntitlementChange(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    kind: 'grant' | 'override',
    changeId: string,
    input: EntitlementRevocation,
  ) {
    return revokeEntitlementChange(
      this.db,
      actor,
      tenantId,
      kind,
      changeId,
      input,
    );
  }
  readEmployees(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
  ) {
    return readTenantEmployees(this.db, actor, tenantId);
  }
  readEmployee(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
  ) {
    return readTenantEmployee(this.db, actor, tenantId, employeeId);
  }
  createEmployee(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    input: EmployeeRecordCreate,
  ) {
    return createTenantEmployee(this.db, actor, tenantId, input);
  }
  updateEmployeeProfile(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
    input: EmployeeProfileUpdate,
  ) {
    return updateTenantEmployeeProfile(
      this.db,
      actor,
      tenantId,
      employeeId,
      input,
    );
  }
  createEmployeeAssignment(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
    input: EmployeeAssignmentCreate,
  ) {
    return createTenantEmployeeAssignment(
      this.db,
      actor,
      tenantId,
      employeeId,
      input,
    );
  }
  activateEmployee(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
    input: EmployeeActivation,
  ) {
    return activateTenantEmployee(this.db, actor, tenantId, employeeId, input);
  }
  scheduleEmployeeTermination(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
    input: EmployeeTermination,
  ) {
    return scheduleTenantEmployeeTermination(
      this.db,
      actor,
      tenantId,
      employeeId,
      input,
    );
  }
  archiveEmployee(
    actor: { identityId: string; mfaVerified: boolean },
    tenantId: string,
    employeeId: string,
    input: EmployeeArchive,
  ) {
    return archiveTenantEmployee(this.db, actor, tenantId, employeeId, input);
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
