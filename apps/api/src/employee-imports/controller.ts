import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { employeeImportUploadSchema, tenantIdSchema } from '@kinto/contracts';
import {
  assertSelectedTenant,
  assertSessionMutation,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';

@Controller('tenants/:tenantId/employee-imports')
export class EmployeeImportsController {
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

  @Post()
  async createPreview(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const input = employeeImportUploadSchema.safeParse(body);
    const key = tenantIdSchema.safeParse(idempotencyKey);
    if (!input.success || !key.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createEmployeeImportPreview(
      context.actor,
      context.tenantId,
      key.data,
      input.data,
    );
  }

  @Get(':batchId')
  async readPreview(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('batchId') batchId: unknown,
  ) {
    const batch = tenantIdSchema.safeParse(batchId);
    if (!batch.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readEmployeeImportPreview(
      context.actor,
      context.tenantId,
      batch.data,
    );
  }
}
