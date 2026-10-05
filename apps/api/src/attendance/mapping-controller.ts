import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  deviceMappingCreateSchema,
  deviceMappingEndSchema,
  deviceMappingQuerySchema,
  deviceMappingResolveQuerySchema,
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

@Controller('tenants/:tenantId/devices/:deviceId/employee-mappings')
export class DeviceMappingController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  private async context(
    req: AuthRequest,
    tenantId: unknown,
    deviceId: unknown,
    mutation = false,
  ) {
    const tenant = tenantIdSchema.safeParse(tenantId),
      device = tenantIdSchema.safeParse(deviceId);
    if (!tenant.success || !device.success) throw new BadRequestException();
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSelectedTenant(session, tenant.data);
    if (mutation) assertSessionMutation(req, this.auth.origin(), session.csrf);
    const now = Math.floor(Date.now() / 1000);
    return {
      tenantId: tenant.data,
      deviceId: device.data,
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
    @Param('tenantId') tenant: unknown,
    @Param('deviceId') device: unknown,
    @Query() query: unknown,
  ) {
    const input = deviceMappingQuerySchema.safeParse(query);
    if (!input.success) throw new BadRequestException();
    const c = await this.context(req, tenant, device);
    return this.database.readDeviceMappings(
      c.actor,
      c.tenantId,
      c.deviceId,
      input.data,
    );
  }
  @Get('resolve') async resolve(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('deviceId') device: unknown,
    @Query() query: unknown,
  ) {
    const input = deviceMappingResolveQuerySchema.safeParse(query);
    if (!input.success) throw new BadRequestException();
    const c = await this.context(req, tenant, device);
    return this.database.resolveDeviceMapping(
      c.actor,
      c.tenantId,
      c.deviceId,
      input.data,
    );
  }
  @Post() async create(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('deviceId') device: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const input = deviceMappingCreateSchema.safeParse(body),
      id = tenantIdSchema.safeParse(key);
    if (!input.success || !id.success) throw new BadRequestException();
    const c = await this.context(req, tenant, device, true);
    return this.database.createDeviceMapping(
      c.actor,
      c.tenantId,
      c.deviceId,
      id.data,
      input.data,
    );
  }
  @Post(':mappingId/end') async end(
    @Req() req: AuthRequest,
    @Param('tenantId') tenant: unknown,
    @Param('deviceId') device: unknown,
    @Param('mappingId') mapping: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    const input = deviceMappingEndSchema.safeParse(body),
      id = tenantIdSchema.safeParse(key),
      mappingId = tenantIdSchema.safeParse(mapping);
    if (!input.success || !id.success || !mappingId.success)
      throw new BadRequestException();
    const c = await this.context(req, tenant, device, true);
    return this.database.endDeviceMapping(
      c.actor,
      c.tenantId,
      c.deviceId,
      mappingId.data,
      id.data,
      input.data,
    );
  }
}
