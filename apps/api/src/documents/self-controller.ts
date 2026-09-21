import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Req,
  Res,
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
import {
  sendDocumentAttachment,
  type DocumentAttachmentResponse,
} from './attachment';
import { DocumentUploadService } from './upload';

@Controller('tenants/:tenantId/me/documents')
export class SelfDocumentsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DocumentUploadService)
    private readonly documents: DocumentUploadService,
  ) {}

  private async context(req: AuthRequest, tenantId: unknown) {
    const tenant = tenantIdSchema.safeParse(tenantId);
    if (!tenant.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
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
    return this.database.readSelfEmployeeDocuments(
      context.actor,
      context.tenantId,
    );
  }

  @Get(':documentId/content')
  async download(
    @Req() req: AuthRequest,
    @Res() response: DocumentAttachmentResponse,
    @Param('tenantId') tenantId: unknown,
    @Param('documentId') documentId: unknown,
  ) {
    const document = tenantIdSchema.safeParse(documentId);
    if (!document.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    const file = await this.documents.downloadSelf(
      context.actor,
      context.tenantId,
      document.data,
    );
    sendDocumentAttachment(response, document.data, file);
  }
}
