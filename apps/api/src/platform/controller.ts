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
  companyProvisioningSchema,
  entitlementChangeSchema,
  entitlementRevocationSchema,
  tenantIdSchema,
} from '@kinto/contracts';
import { z } from 'zod';
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

  private async mutationActor(req: AuthRequest) {
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    const now = Math.floor(Date.now() / 1000);
    return {
      identityId: session.identityId,
      mfaVerified:
        session.principal.mfaVerified &&
        session.authTime <= now &&
        now - session.authTime <= 300,
    };
  }

  @Post('tenants')
  @HttpCode(202)
  async provisionCompany(
    @Req() req: AuthRequest,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const actor = await this.mutationActor(req);
    const key = tenantIdSchema.safeParse(idempotencyKey);
    const input = companyProvisioningSchema.safeParse(body);
    if (!key.success || !input.success) throw new BadRequestException();
    const provisioned = await this.database.provisionCompany(
      actor,
      key.data,
      input.data,
    );
    const owner = await this.ownerProvisioning.attempt(
      provisioned.provisioningRequestId,
      input.data.initialOwnerEmail,
    );
    return owner ? { ...provisioned, status: owner.status } : provisioned;
  }

  @Post('tenants/:tenantId/entitlement-changes/preview')
  @HttpCode(200)
  async previewEntitlement(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantIdValue: unknown,
    @Body() body: unknown,
  ) {
    const actor = await this.mutationActor(req);
    const tenantId = tenantIdSchema.safeParse(tenantIdValue);
    const input = entitlementChangeSchema.safeParse(body);
    if (!tenantId.success || !input.success) throw new BadRequestException();
    return this.database.previewEntitlementChange(
      actor,
      tenantId.data,
      input.data,
    );
  }

  @Post('tenants/:tenantId/entitlement-changes')
  async createEntitlement(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantIdValue: unknown,
    @Body() body: unknown,
  ) {
    const actor = await this.mutationActor(req);
    const tenantId = tenantIdSchema.safeParse(tenantIdValue);
    const input = entitlementChangeSchema.safeParse(body);
    if (!tenantId.success || !input.success) throw new BadRequestException();
    return this.database.createEntitlementChange(
      actor,
      tenantId.data,
      input.data,
    );
  }

  @Post('tenants/:tenantId/entitlement-changes/:kind/:changeId/revocation')
  @HttpCode(200)
  async revokeEntitlement(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantIdValue: unknown,
    @Param('kind') kindValue: unknown,
    @Param('changeId') changeIdValue: unknown,
    @Body() body: unknown,
  ) {
    const actor = await this.mutationActor(req);
    const tenantId = tenantIdSchema.safeParse(tenantIdValue);
    const changeId = tenantIdSchema.safeParse(changeIdValue);
    const kind = z.enum(['grant', 'override']).safeParse(kindValue);
    const input = entitlementRevocationSchema.safeParse(body);
    if (
      !tenantId.success ||
      !changeId.success ||
      !kind.success ||
      !input.success
    )
      throw new BadRequestException();
    return this.database.revokeEntitlementChange(
      actor,
      tenantId.data,
      kind.data,
      changeId.data,
      input.data,
    );
  }
}
