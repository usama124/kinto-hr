import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { attendanceAllocationSchema, tenantIdSchema } from '@kinto/contracts';
import {
  assertSelectedTenant,
  assertSessionMutation,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
@Controller()
export class AttendanceAllocationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  private async context(
    req: AuthRequest,
    tenantId: unknown,
    platform: boolean,
    mutation = false,
  ) {
    const tenant = tenantIdSchema.safeParse(tenantId);
    if (!tenant.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    if (mutation) assertSessionMutation(req, this.auth.origin(), session.csrf);
    if (!platform) assertSelectedTenant(session, tenant.data);
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
  @Get('tenants/:tenantId/attendance-entitlements') async tenant(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
  ) {
    const context = await this.context(req, tenantId, false);
    return this.database.readAttendanceAllocation(
      context.actor,
      context.tenantId,
      false,
    );
  }
  @Get('platform/tenants/:tenantId/attendance-entitlements') async platform(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
  ) {
    const context = await this.context(req, tenantId, true);
    return this.database.readAttendanceAllocation(
      context.actor,
      context.tenantId,
      true,
    );
  }
  @Put('platform/tenants/:tenantId/attendance-entitlements') async change(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const id = tenantIdSchema.safeParse(key);
    const input = attendanceAllocationSchema.safeParse(body);
    if (!id.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true, true);
    return this.database.changeAttendanceAllocation(
      context.actor,
      context.tenantId,
      id.data,
      input.data,
    );
  }
}
