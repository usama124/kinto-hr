import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  employeeAssignmentCreateSchema,
  employeeActivationSchema,
  employeeTerminationSchema,
  employeeArchiveSchema,
  employeeRehireSchema,
  employeeProfileUpdateSchema,
  employeePrivateDetailsUpdateSchema,
  employeeCompensationRevisionSchema,
  employeeChecklistTaskCreateSchema,
  employeeChecklistTaskCompletionSchema,
  employeeRecordCreateSchema,
  employeeDocumentRegistrationSchema,
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
import { DocumentUploadService } from '../documents/upload';

@Controller('tenants/:tenantId/employees')
export class EmployeesController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DocumentUploadService)
    private readonly documents: DocumentUploadService,
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

  @Get(':employeeId/documents')
  async readDocuments(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    if (!employee.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readEmployeeDocuments(
      context.actor,
      context.tenantId,
      employee.data,
    );
  }

  @Post(':employeeId/documents')
  async registerDocument(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const key = tenantIdSchema.safeParse(idempotencyKey);
    const input = employeeDocumentRegistrationSchema.safeParse(body);
    if (!employee.success || !key.success || !input.success)
      throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.registerEmployeeDocument(
      context.actor,
      context.tenantId,
      employee.data,
      key.data,
      input.data,
    );
  }

  @Put(':employeeId/documents/:documentId/content')
  async uploadDocument(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Param('documentId') documentId: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const document = tenantIdSchema.safeParse(documentId);
    if (!employee.success || !document.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.documents.upload(
      context.actor,
      context.tenantId,
      employee.data,
      document.data,
      req as AuthRequest & AsyncIterable<Uint8Array>,
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

  @Get(':employeeId/compensation')
  async readCompensation(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    if (!employee.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readEmployeeCompensation(
      context.actor,
      context.tenantId,
      employee.data,
    );
  }

  @Post(':employeeId/compensation')
  async reviseCompensation(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeCompensationRevisionSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.reviseEmployeeCompensation(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Get(':employeeId/private-details')
  async readPrivateDetails(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    if (!employee.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readEmployeePrivateDetails(
      context.actor,
      context.tenantId,
      employee.data,
    );
  }

  @Get(':employeeId/checklist')
  async readChecklist(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    if (!employee.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readEmployeeChecklist(
      context.actor,
      context.tenantId,
      employee.data,
    );
  }

  @Post(':employeeId/checklist')
  async createChecklistTask(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeChecklistTaskCreateSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createEmployeeChecklistTask(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Post(':employeeId/checklist/:taskId/complete')
  async completeChecklistTask(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Param('taskId') taskId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const task = tenantIdSchema.safeParse(taskId);
    const input = employeeChecklistTaskCompletionSchema.safeParse(body);
    if (!employee.success || !task.success || !input.success)
      throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.completeEmployeeChecklistTask(
      context.actor,
      context.tenantId,
      employee.data,
      task.data,
      input.data,
    );
  }

  @Put(':employeeId/private-details')
  async updatePrivateDetails(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeePrivateDetailsUpdateSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.updateEmployeePrivateDetails(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Post(':employeeId/activate')
  async activate(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeActivationSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.activateEmployee(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Post(':employeeId/terminate')
  async terminate(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeTerminationSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.scheduleEmployeeTermination(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Post(':employeeId/archive')
  async archive(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeArchiveSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.archiveEmployee(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }

  @Post(':employeeId/rehire')
  async rehire(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('employeeId') employeeId: unknown,
    @Body() body: unknown,
  ) {
    const employee = tenantIdSchema.safeParse(employeeId);
    const input = employeeRehireSchema.safeParse(body);
    if (!employee.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.rehireEmployee(
      context.actor,
      context.tenantId,
      employee.data,
      input.data,
    );
  }
}
