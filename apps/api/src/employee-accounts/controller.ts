import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  employeeAccountProvisioningSchema,
  tenantIdSchema,
} from '@kinto/contracts';
import { AuthService } from '../auth/service';
import {
  assertSessionMutation,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { DatabaseService } from '../database.service';
import { OwnerProvisioningService } from '../provisioning/service';

@Controller('tenants/:tenantId/employees/:employeeId/account-invitations')
export class EmployeeAccountsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OwnerProvisioningService)
    private readonly accountProvisioning: OwnerProvisioningService,
  ) {}

  @Post()
  @HttpCode(202)
  async requestAccount(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    const parsedEmployee = tenantIdSchema.safeParse(employeeId);
    const parsedKey = tenantIdSchema.safeParse(idempotencyKey);
    const input = employeeAccountProvisioningSchema.safeParse(body);
    if (
      !parsedTenant.success ||
      !parsedEmployee.success ||
      !parsedKey.success ||
      !input.success
    )
      throw new BadRequestException();
    const now = Math.floor(Date.now() / 1000);
    const provisioned = await this.database.provisionEmployeeAccount(
      {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
      parsedTenant.data,
      parsedEmployee.data,
      parsedKey.data,
      input.data,
    );
    const employee = await this.accountProvisioning.attemptEmployee(
      provisioned.accountRequestId,
      input.data.email,
    );
    return employee ? { ...provisioned, status: employee.status } : provisioned;
  }
}
