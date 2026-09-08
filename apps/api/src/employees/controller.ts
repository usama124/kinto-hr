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
  employeeAssignmentCreateSchema,
  employeeProfileUpdateSchema,
  employeeRecordCreateSchema,
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

@Controller('tenants/:tenantId/employees')
export class EmployeesController {
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
    return this.database.readEmployees(context.actor, context.tenantId);
  }

  @Get(':employeeId')
  async read(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    if (!employee.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readEmployee(
      context.actor,
      context.tenantId,
      employee.data,
    );
  }

  @Post()
  async create(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Body() body: unknown,
  ) {
    const input = employeeRecordCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createEmployee(
      context.actor,
      context.tenantId,
      input.data,
    );
  }

  @Put(':employeeId')
  async updateProfile(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeProfileUpdateSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.updateEmployeeProfile(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Post(':employeeId/assignments')
  async createAssignment(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeAssignmentCreateSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createEmployeeAssignment(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }
}
