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
  administratorInvitationSchema,
  tenantIdSchema,
} from '@kinto/contracts';
import {
  assertSessionMutation,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { OwnerProvisioningService } from '../provisioning/service';

@Controller('tenants/:tenantId/administrator-invitations')
export class AdministratorInvitationsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OwnerProvisioningService)
    private readonly provisioning: OwnerProvisioningService,
  ) {}

  @Post()
  @HttpCode(202)
  async invite(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    const parsedKey = tenantIdSchema.safeParse(idempotencyKey);
    const input = administratorInvitationSchema.safeParse(body);
    if (!parsedTenant.success || !parsedKey.success || !input.success)
      throw new BadRequestException();
    const now = Math.floor(Date.now() / 1000);
    const requested = await this.database.provisionAdministrator(
      {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
      parsedTenant.data,
      parsedKey.data,
      input.data,
    );
    const provider = await this.provisioning.attemptAdministrator(
      requested.accountRequestId,
      input.data.email,
    );
    return provider ? { ...requested, status: provider.status } : requested;
  }
}
