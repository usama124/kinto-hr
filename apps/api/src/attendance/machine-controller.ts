import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  connectorCredentialSchema,
  connectorRedemptionRequestSchema,
  connectorHeartbeatRequestSchema,
  connectorHeartbeatResultSchema,
} from '@kinto/contracts';
import type { AuthRequest } from '../auth/controller';
import { MachineService } from './machine-service';

@Controller('local-machine/connectors')
export class MachineController {
  constructor(
    @Inject(MachineService) private readonly machine: MachineService,
  ) {}
  private async context(req: AuthRequest) {
    this.machine.enabled();
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        req.socket.remoteAddress ?? '',
      )
    )
      throw new ForbiddenException();
    // Machine requests never accept browser sessions, browser origins or proxy assertions.
    if (
      [
        'cookie',
        'origin',
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
      ].some((key) => req.headers[key] !== undefined)
    )
      throw new ForbiddenException();
    await this.machine.limit(req.socket.remoteAddress!);
  }
  @Post('redemption')
  @HttpCode(201)
  async redeem(@Req() req: AuthRequest, @Body() body: unknown) {
    await this.context(req);
    if (req.headers.authorization !== undefined)
      throw new BadRequestException();
    const input = connectorRedemptionRequestSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    return this.machine.redeem(input.data.token);
  }
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@Req() req: AuthRequest, @Body() body: unknown) {
    await this.context(req);
    if (!connectorHeartbeatRequestSchema.safeParse(body).success)
      throw new BadRequestException();
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw new UnauthorizedException();
    const credential = connectorCredentialSchema.safeParse(header.slice(7));
    if (!credential.success) throw new UnauthorizedException();
    return connectorHeartbeatResultSchema.parse({
      connector: await this.machine.authorize(credential.data),
    });
  }
}
