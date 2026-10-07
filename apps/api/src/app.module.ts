import { MachineService } from './attendance/machine-service';
import { MachineController } from './attendance/machine-controller';
import { LocalConnectorOwnerController } from './attendance/local-owner-controller';
import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type Health } from '@kinto/contracts';
import { DatabaseService } from './database.service';
import { AuthService } from './auth/service';
import { AuthController } from './auth/controller';
import { PlatformController } from './platform/controller';
import { OwnerProvisioningService } from './provisioning/service';
import { EmployeeAccountsController } from './employee-accounts/controller';
import { MembershipsController } from './memberships/controller';
import { AdministratorInvitationsController } from './administrator-invitations/controller';
import { SecurityAuditController } from './security-audit/controller';
import { ConnectorEnrollmentController } from './attendance/enrollment-controller';
import { AttendanceAllocationController } from './attendance/allocation-controller';
import { DeviceMappingController } from './attendance/mapping-controller';
import { DeviceInventoryController } from './attendance/device-controller';
import { OrganizationController } from './organization/controller';
import { EntitlementsController } from './entitlements/controller';
import { EmployeesController } from './employees/controller';
import { EmployeeImportsController } from './employee-imports/controller';
import { DocumentUploadService } from './documents/upload';
import { SelfDocumentsController } from './documents/self-controller';
import { SelfProfileController } from './employees/self-profile-controller';
import { ProfileChangeController } from './employees/profile-change-controller';
import { ProfileChangeDecisionController } from './employees/profile-change-decision-controller';
import { ReportsController } from './reports/controller';
import { ReportExportsController } from './reports/export-controller';
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MachineService) private readonly machine: MachineService,
  ) {}
  @Get('live') live(): Health {
    return { status: 'ok', service: 'kinto-api' };
  }
  @Get('ready') async ready(): Promise<Health> {
    try {
      await this.database.ready();
      await this.auth.ready();
      await this.machine.ready();
      return this.live();
    } catch {
      throw new ServiceUnavailableException('Service is not ready');
    }
  }
}
@Module({
  controllers: [
    HealthController,
    AuthController,
    PlatformController,
    EmployeeAccountsController,
    MembershipsController,
    AdministratorInvitationsController,
    SecurityAuditController,
    OrganizationController,
    DeviceInventoryController,
    DeviceMappingController,
    AttendanceAllocationController,
    ConnectorEnrollmentController,
    MachineController,
    LocalConnectorOwnerController,
    EntitlementsController,
    EmployeesController,
    EmployeeImportsController,
    SelfDocumentsController,
    SelfProfileController,
    ProfileChangeController,
    ProfileChangeDecisionController,
    ReportsController,
    ReportExportsController,
  ],
  providers: [
    MachineService,
    DatabaseService,
    AuthService,
    OwnerProvisioningService,
    DocumentUploadService,
  ],
})
export class AppModule {}
