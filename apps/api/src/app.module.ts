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
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  @Get('live') live(): Health {
    return { status: 'ok', service: 'kinto-api' };
  }
  @Get('ready') async ready(): Promise<Health> {
    try {
      await this.database.ready();
      await this.auth.ready();
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
  ],
  providers: [DatabaseService, AuthService, OwnerProvisioningService],
})
export class AppModule {}
