import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  tenantIdSchema,
  workforceReportExportCreateSchema,
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
import { workforceExportFileName, workforceHeadcountCsv } from './csv';

type AttachmentResponse = {
  setHeader(name: string, value: string | number): void;
  end(bytes: Buffer): void;
};

@Controller('tenants/:tenantId/exports')
export class ReportExportsController {
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
  @HttpCode(202)
  async create(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const key = tenantIdSchema.safeParse(idempotencyKey);
    const input = workforceReportExportCreateSchema.safeParse(body);
    if (!key.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createWorkforceReportExport(
      context.actor,
      context.tenantId,
      key.data,
      input.data,
    );
  }

  @Get(':exportId')
  async read(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('exportId') exportId: unknown,
  ) {
    const selectedExport = tenantIdSchema.safeParse(exportId);
    if (!selectedExport.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readWorkforceReportExport(
      context.actor,
      context.tenantId,
      selectedExport.data,
    );
  }

  @Get(':exportId/content')
  async download(
    @Req() req: AuthRequest,
    @Res() response: AttachmentResponse,
    @Param('tenantId') tenantId: unknown,
    @Param('exportId') exportId: unknown,
  ) {
    const selectedExport = tenantIdSchema.safeParse(exportId);
    if (!selectedExport.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    const download = await this.database.authorizeWorkforceReportExportDownload(
      context.actor,
      context.tenantId,
      selectedExport.data,
    );
    const bytes = workforceHeadcountCsv(download.report);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Length', bytes.length);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${workforceExportFileName(download)}"`,
    );
    response.end(bytes);
  }
}
