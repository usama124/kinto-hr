import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  tenantIdSchema,
  workforceHeadcountQuerySchema,
} from '@kinto/contracts';
import {
  assertSelectedTenant,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';

@Controller('tenants/:tenantId/reports')
export class ReportsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get('headcount')
  async headcount(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Query() query: unknown,
  ) {
    const tenant = tenantIdSchema.safeParse(tenantId);
    const input = workforceHeadcountQuerySchema.safeParse(query);
    if (!tenant.success || !input.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSelectedTenant(session, tenant.data);
    const now = Math.floor(Date.now() / 1000);
    return this.database.readWorkforceHeadcountReport(
      {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
      tenant.data,
      input.data,
    );
  }
}
