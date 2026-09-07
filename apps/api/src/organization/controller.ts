import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  branchCreateSchema,
  branchUpdateSchema,
  legalEntityCreateSchema,
  legalEntityUpdateSchema,
  organizationPolicyDraftSchema,
  organizationPolicyPublishSchema,
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

@Controller('tenants/:tenantId/organization')
export class OrganizationController {
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
  async read(@Req() req: AuthRequest, @Param('tenantId') tenantId: unknown) {
    const context = await this.context(req, tenantId);
    return this.database.readOrganization(context.actor, context.tenantId);
  }

  @Post('legal-entities')
  async createLegalEntity(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Body() body: unknown,
  ) {
    const input = legalEntityCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createLegalEntity(
      context.actor,
      context.tenantId,
      input.data,
    );
  }

  @Put('legal-entities/:entityId')
  async updateLegalEntity(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('entityId') entityId: unknown,
    @Body() body: unknown,
  ) {
    const entity = tenantIdSchema.safeParse(entityId);
    const input = legalEntityUpdateSchema.safeParse(body);
    if (!entity.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.updateLegalEntity(
      context.actor,
      context.tenantId,
      entity.data,
      input.data,
    );
  }

  @Post('branches')
  async createBranch(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Body() body: unknown,
  ) {
    const input = branchCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createBranch(
      context.actor,
      context.tenantId,
      input.data,
    );
  }

  @Put('branches/:branchId')
  async updateBranch(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('branchId') branchId: unknown,
    @Body() body: unknown,
  ) {
    const branch = tenantIdSchema.safeParse(branchId);
    const input = branchUpdateSchema.safeParse(body);
    if (!branch.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.updateBranch(
      context.actor,
      context.tenantId,
      branch.data,
      input.data,
    );
  }

  @Post('policies/organization-defaults/drafts')
  async createPolicyDraft(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Body() body: unknown,
  ) {
    const input = organizationPolicyDraftSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createPolicyDraft(
      context.actor,
      context.tenantId,
      input.data,
    );
  }

  @Get('policies/organization-defaults/drafts/:policyId/preview')
  async previewPolicy(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('policyId') policyId: unknown,
  ) {
    const policy = tenantIdSchema.safeParse(policyId);
    if (!policy.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.previewPolicy(
      context.actor,
      context.tenantId,
      policy.data,
    );
  }

  @Post('policies/organization-defaults/drafts/:policyId/publication')
  async publishPolicy(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('policyId') policyId: unknown,
    @Body() body: unknown,
  ) {
    const policy = tenantIdSchema.safeParse(policyId);
    const input = organizationPolicyPublishSchema.safeParse(body);
    if (!policy.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.publishPolicy(
      context.actor,
      context.tenantId,
      policy.data,
      input.data,
    );
  }
}
