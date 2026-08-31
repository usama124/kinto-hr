import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  membershipRevocationSchema,
  membershipRoleUpdateSchema,
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

@Controller('tenants/:tenantId/memberships')
export class MembershipsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private async actor(req: AuthRequest) {
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    const now = Math.floor(Date.now() / 1000);
    return {
      session,
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
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    if (!parsedTenant.success) throw new BadRequestException();
    const { actor } = await this.actor(req);
    return {
      memberships: await this.database.listMemberships(
        actor,
        parsedTenant.data,
      ),
    };
  }

  @Put(':membershipId/roles')
  async updateRoles(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('membershipId') membershipId: unknown,
    @Body() body: unknown,
  ) {
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    const parsedMembership = tenantIdSchema.safeParse(membershipId);
    const input = membershipRoleUpdateSchema.safeParse(body);
    if (!parsedTenant.success || !parsedMembership.success || !input.success)
      throw new BadRequestException();
    const { session, actor } = await this.actor(req);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    return this.database.updateMembershipRoles(
      actor,
      parsedTenant.data,
      parsedMembership.data,
      input.data,
    );
  }

  @Post(':membershipId/revocation')
  @HttpCode(200)
  async revoke(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('membershipId') membershipId: unknown,
    @Body() body: unknown,
  ) {
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    const parsedMembership = tenantIdSchema.safeParse(membershipId);
    const input = membershipRevocationSchema.safeParse(body);
    if (!parsedTenant.success || !parsedMembership.success || !input.success)
      throw new BadRequestException();
    const { session, actor } = await this.actor(req);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    return this.database.revokeMembership(
      actor,
      parsedTenant.data,
      parsedMembership.data,
      input.data,
    );
  }
}
