import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  enrollmentIssueSchema,
  enrollmentRevokeSchema,
  enrollmentListQuerySchema,
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
import { MachineService } from './machine-service';
@Controller('tenants/:tenantId/local-connectors')
export class LocalConnectorOwnerController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MachineService) private readonly machine: MachineService,
  ) {}
  private async context(req: AuthRequest, value: unknown, mutation = false) {
    this.machine.enabled();
    const tenant = tenantIdSchema.safeParse(value);
    if (!tenant.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSelectedTenant(session, tenant.data);
    if (mutation) assertSessionMutation(req, this.auth.origin(), session.csrf);
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
  @Get('enrollment-tokens') async list(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Query() query: unknown,
  ) {
    this.machine.enabled();
    const parsed = enrollmentListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.machine.enrollments(
      context.actor,
      context.tenantId,
      parsed.data,
    );
  }
  @Post('enrollment-tokens') async issue(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    this.machine.enabled();
    const id = tenantIdSchema.safeParse(key),
      input = enrollmentIssueSchema.safeParse(body);
    if (!id.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.machine.issue(
      context.actor,
      context.tenantId,
      id.data,
      input.data,
    );
  }
  @Post('enrollment-tokens/:id/revocation') async revoke(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('id') id: unknown,
    @Body() body: unknown,
  ) {
    this.machine.enabled();
    const record = tenantIdSchema.safeParse(id),
      input = enrollmentRevokeSchema.safeParse(body);
    if (!record.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.machine.revokeEnrollment(
      context.actor,
      context.tenantId,
      record.data,
    );
  }
  @Get('credentials') async credentials(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Query() query: unknown,
  ) {
    this.machine.enabled();
    const parsed = enrollmentListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.machine.credentials(
      context.actor,
      context.tenantId,
      parsed.data,
    );
  }
  @Post('credentials/:id/revocation') async revokeCredential(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('id') id: unknown,
    @Body() body: unknown,
  ) {
    this.machine.enabled();
    const record = tenantIdSchema.safeParse(id),
      input = enrollmentRevokeSchema.safeParse(body);
    if (!record.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.machine.revokeCredential(
      context.actor,
      context.tenantId,
      record.data,
    );
  }
}
