import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { tenantIdSchema } from '@kinto/contracts';
import { type AuthRequest } from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { readEmployeeSelfContext } from '../employees/self-context';
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

  @Get()
  async list(@Req() req: AuthRequest, @Param('tenantId') tenantId: unknown) {
    const context = await readEmployeeSelfContext(this.auth, req, tenantId);
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
    const context = await readEmployeeSelfContext(this.auth, req, tenantId);
    const file = await this.documents.downloadSelf(
      context.actor,
      context.tenantId,
      document.data,
    );
    sendDocumentAttachment(response, document.data, file);
  }
}
