import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  deviceCreateSchema,
  deviceUpdateSchema,
  deviceListQuerySchema,
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
@Controller('tenants/:tenantId/devices')
export class DeviceInventoryController {
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

  @Get() async list(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Query() query: unknown,
  ) {
    const input = deviceListQuerySchema.safeParse(query);
    if (!input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId);
    return this.database.readDevices(
      context.actor,
      context.tenantId,
      input.data,
    );
  }
  @Post() async create(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Body() body: unknown,
  ) {
    const input = deviceCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.createDevice(
      context.actor,
      context.tenantId,
      input.data,
    );
  }
  @Put(':deviceId') async update(
    @Req() req: AuthRequest,
    @Param('tenantId') tenantId: unknown,
    @Param('deviceId') deviceId: unknown,
    @Body() body: unknown,
  ) {
    const id = tenantIdSchema.safeParse(deviceId);
    const input = deviceUpdateSchema.safeParse(body);
    if (!id.success || !input.success) throw new BadRequestException();
    const context = await this.context(req, tenantId, true);
    return this.database.updateDevice(
      context.actor,
      context.tenantId,
      id.data,
      input.data,
    );
  }
}
