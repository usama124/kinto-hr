import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  employeeProfileChangeDecisionInputSchema,
  tenantIdSchema,
} from '@kinto/contracts';
import {
  assertSelectedTenant,
  assertSessionMutation,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';

@Controller('tenants/:tenantId/profile-change-requests')
export class ProfileChangeDecisionController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private async context(req: AuthRequest, tenantId: unknown, mutation = false) {
    const tenant = tenantIdSchema.safeParse(tenantId);
    if (!tenant.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    if (mutation) assertSessionMutation(req, this.auth.origin(), session.csrf);
    assertSelectedTenant(session, tenant.data);
    const now = Math.floor(Date.now() / 1000);
    return {
      tenantId: tenant.data,
      actor: {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
    };
  }

  @Get()
  async list(@Req() req: AuthRequest, @Param('tenantId') tenantId: unknown) {
    const context = await this.context(req, tenantId);
    return this.database.readProfileChangeRequests(
      context.actor,
      context.tenantId,
    );
  }

  @Post(':requestId/decision')
  async decide(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('requestId') requestId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const request = tenantIdSchema.safeParse(requestId);
    const key = tenantIdSchema.safeParse(idempotencyKey);
    const input = employeeProfileChangeDecisionInputSchema.safeParse(body);
    if (!request.success || !key.success || !input.success)
      throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.decideProfileChangeRequest(
      context.actor,
      context.tenantId,
      request.data,
      key.data,
      input.data,
    );
  }
}
