import {
  Headers,
  Query,
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
  companyCalendarQuerySchema,
  companyCalendarDaysQuerySchema,
  companyCalendarPolicyDraftSchema,
  companyCalendarPublishSchema,
  leaveTypeCreateSchema,
  leavePolicyDraftInputSchema,
  leavePolicyPublishSchema,
  leavePolicyQuerySchema,
  leaveTypeQuerySchema,
  attendanceTimingQuerySchema,
  attendanceTimingPolicyDraftSchema,
  attendanceTimingPublishSchema,
  branchCreateSchema,
  branchUpdateSchema,
  legalEntityCreateSchema,
  legalEntityUpdateSchema,
  organizationPolicyDraftSchema,
  organizationPolicyPublishSchema,
  organizationCatalogCreateSchema,
  organizationCatalogUpdateSchema,
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

  // Register static leave-type creation before the generic catalog POST.
  @Get('leave-types') async listLeaveTypes(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Query() query: unknown,
  ) {
    const value = leaveTypeQuerySchema.safeParse(query);
    if (!value.success) throw new BadRequestException();
    const c = await this.context(req, tenant);
    return this.database.listLeaveTypes(c.actor, c.tenantId, value.data);
  }
  @Get('leave-types/:typeId/policies') async listLeavePolicies(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('typeId') type: unknown,
    @Query() query: unknown,
  ) {
    const value = leavePolicyQuerySchema.safeParse(query),
      id = tenantIdSchema.safeParse(type);
    if (!value.success || !id.success) throw new BadRequestException();
    const c = await this.context(req, tenant);
    return this.database.listLeavePolicies(
      c.actor,
      c.tenantId,
      id.data,
      value.data,
    );
  }
  @Post('leave-types') async createLeaveType(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = leaveTypeCreateSchema.safeParse(body),
      k = tenantIdSchema.safeParse(key);
    if (!value.success || !k.success) throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.createLeaveType(
      c.actor,
      c.tenantId,
      k.data,
      value.data,
    );
  }
  @Post('leave-types/:typeId/policies/drafts') async createLeavePolicy(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('typeId') type: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = leavePolicyDraftInputSchema.safeParse(body),
      k = tenantIdSchema.safeParse(key),
      id = tenantIdSchema.safeParse(type);
    if (!value.success || !k.success || !id.success)
      throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.createLeavePolicy(
      c.actor,
      c.tenantId,
      id.data,
      k.data,
      value.data,
    );
  }
  @Post('leave-types/:typeId/policies/:policyId/publication')
  async publishLeavePolicy(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('typeId') type: unknown,
    @Param('policyId') policy: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = leavePolicyPublishSchema.safeParse(body),
      k = tenantIdSchema.safeParse(key),
      id = tenantIdSchema.safeParse(type),
      p = tenantIdSchema.safeParse(policy);
    if (!value.success || !k.success || !id.success || !p.success)
      throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.publishLeavePolicy(
      c.actor,
      c.tenantId,
      id.data,
      p.data,
      k.data,
      value.data,
    );
  }
  @Post(':catalog')
  async createCatalogEntry(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('catalog') catalogValue: unknown,
    @Body() body: unknown,
  ) {
    const input = organizationCatalogCreateSchema.safeParse(body);
    if (
      !input.success ||
      (catalogValue !== 'departments' && catalogValue !== 'designations')
    )
      throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createOrganizationCatalogEntry(
      context.actor,
      context.tenantId,
      catalogValue === 'departments' ? 'department' : 'designation',
      input.data,
    );
  }

  @Put(':catalog/:resourceId')
  async updateCatalogEntry(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('catalog') catalogValue: unknown,
    @Param('resourceId') resourceIdValue: unknown,
    @Body() body: unknown,
  ) {
    const resourceId = tenantIdSchema.safeParse(resourceIdValue);
    const input = organizationCatalogUpdateSchema.safeParse(body);
    if (
      !resourceId.success ||
      !input.success ||
      (catalogValue !== 'departments' && catalogValue !== 'designations')
    )
      throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.updateOrganizationCatalogEntry(
      context.actor,
      context.tenantId,
      catalogValue === 'departments' ? 'department' : 'designation',
      resourceId.data,
      input.data,
    );
  }

  @Get('policies/work-calendar') async listCalendar(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Query() query: unknown,
  ) {
    const value = companyCalendarQuerySchema.safeParse(query);
    if (!value.success) throw new BadRequestException();
    const c = await this.context(req, tenant);
    return this.database.listCalendarPolicies(c.actor, c.tenantId, value.data);
  }
  @Get('policies/work-calendar/days') async calendarDays(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Query() query: unknown,
  ) {
    const value = companyCalendarDaysQuerySchema.safeParse(query);
    if (!value.success) throw new BadRequestException();
    const c = await this.context(req, tenant);
    return this.database.resolveCalendarDays(c.actor, c.tenantId, value.data);
  }
  @Post('policies/work-calendar/drafts') async createCalendar(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = companyCalendarPolicyDraftSchema.safeParse(body),
      request = tenantIdSchema.safeParse(key);
    if (!value.success || !request.success) throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.createCalendarPolicy(
      c.actor,
      c.tenantId,
      request.data,
      value.data,
    );
  }
  @Post('policies/work-calendar/:policyId/publication') async publishCalendar(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('policyId') id: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = companyCalendarPublishSchema.safeParse(body),
      request = tenantIdSchema.safeParse(key),
      policy = tenantIdSchema.safeParse(id);
    if (!value.success || !request.success || !policy.success)
      throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.publishCalendarPolicy(
      c.actor,
      c.tenantId,
      policy.data,
      request.data,
      value.data,
    );
  }
  @Get('policies/attendance-timing') async listTiming(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Query() query: unknown,
  ) {
    const value = attendanceTimingQuerySchema.safeParse(query);
    if (!value.success) throw new BadRequestException();
    const c = await this.context(req, tenant);
    return this.database.listTimingPolicies(c.actor, c.tenantId, value.data);
  }
  @Get('policies/attendance-timing/:policyId/preview') async previewTiming(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('policyId') id: unknown,
  ) {
    const value = tenantIdSchema.safeParse(id);
    if (!value.success) throw new BadRequestException();
    const c = await this.context(req, tenant);
    return this.database.previewTimingPolicy(c.actor, c.tenantId, value.data);
  }
  @Post('policies/attendance-timing/drafts') async createTiming(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = attendanceTimingPolicyDraftSchema.safeParse(body),
      request = tenantIdSchema.safeParse(key);
    if (!value.success || !request.success) throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.createTimingPolicy(
      c.actor,
      c.tenantId,
      request.data,
      value.data,
    );
  }
  @Post('policies/attendance-timing/:policyId/publication') async publishTiming(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('policyId') id: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const value = attendanceTimingPublishSchema.safeParse(body),
      request = tenantIdSchema.safeParse(key),
      policy = tenantIdSchema.safeParse(id);
    if (!value.success || !request.success || !policy.success)
      throw new BadRequestException();
    const c = await this.context(req, tenant, true);
    return this.database.publishTimingPolicy(
      c.actor,
      c.tenantId,
      policy.data,
      request.data,
      value.data,
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
