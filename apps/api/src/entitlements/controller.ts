import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { tenantIdSchema } from '@kinto/contracts';
import {
  assertSelectedTenant,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';

@Controller('tenants/:tenantId/entitlements')
export class EntitlementsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get()
  async read(@Req() req: AuthRequest, @Param('tenantId') tenantId: unknown) {
    const tenant = tenantIdSchema.safeParse(tenantId);
    if (!tenant.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSelectedTenant(session, tenant.data);
    const now = Math.floor(Date.now() / 1000);
    return this.database.readEntitlements(
      {
        identityId: session.identityId,
        mfaVerified:
          session.principal.mfaVerified &&
          session.authTime <= now &&
          now - session.authTime <= 300,
      },
      tenant.data,
    );
  }
}
