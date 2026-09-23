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
} from '@nestjs/common';
import {
  employeeProfileChangeRequestInputSchema,
  tenantIdSchema,
} from '@kinto/contracts';
import { type AuthRequest } from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { readEmployeeSelfContext } from './self-context';

@Controller('tenants/:tenantId/me/profile-change-requests')
export class ProfileChangeController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get()
  async list(@Req() req: AuthRequest, @Param('tenantId') tenantId: unknown) {
    const context = await readEmployeeSelfContext(this.auth, req, tenantId);
    return this.database.readSelfProfileChangeRequests(
      context.actor,
      context.tenantId,
    );
  }

  @Post()
  async submit(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const key = tenantIdSchema.safeParse(idempotencyKey);
    const input = employeeProfileChangeRequestInputSchema.safeParse(body);
    if (!key.success || !input.success) throw new BadRequestException();
    const context = await readEmployeeSelfContext(
      this.auth,
      req,
      tenantId,
      true,
    );
    return this.database.submitSelfProfileChangeRequest(
      context.actor,
      context.tenantId,
      key.data,
      input.data,
    );
  }
}
