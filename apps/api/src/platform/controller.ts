import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { companyProvisioningSchema, tenantIdSchema } from '@kinto/contracts';
import { AuthService } from '../auth/service';
import {
  assertSessionMutation,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { DatabaseService } from '../database.service';
import { OwnerProvisioningService } from '../provisioning/service';

@Controller('platform')
export class PlatformController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OwnerProvisioningService)
    private readonly ownerProvisioning: OwnerProvisioningService,
  ) {}

  @Post('tenants')
  @HttpCode(202)
  async provisionCompany(
    @Req() req: AuthRequest,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    const key = tenantIdSchema.safeParse(idempotencyKey);
    const input = companyProvisioningSchema.safeParse(body);
    if (!key.success || !input.success) throw new BadRequestException();
    const now = Math.floor(Date.now() / 1000);
    const provisioned = await this.database.provisionCompany(
      {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
      key.data,
      input.data,
    );
    const owner = await this.ownerProvisioning.attempt(
      provisioned.provisioningRequestId,
      input.data.initialOwnerEmail,
    );
    return owner ? { ...provisioned, status: owner.status } : provisioned;
  }
}
