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
import { securityAuditQuerySchema, tenantIdSchema } from '@kinto/contracts';
import {
  assertSelectedTenant,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';

@Controller('tenants/:tenantId/security-audit')
export class SecurityAuditController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get()
  async list(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Query() query: unknown,
  ) {
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    const parsedQuery = securityAuditQuerySchema.safeParse(query);
    if (!parsedTenant.success || !parsedQuery.success)
      throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSelectedTenant(session, parsedTenant.data);
    const now = Math.floor(Date.now() / 1000);
    return this.database.listSecurityAudit(
      {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
      parsedTenant.data,
      parsedQuery.data,
    );
  }
}
