import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { type AuthRequest } from '../auth/controller';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { readEmployeeSelfContext } from './self-context';

@Controller('tenants/:tenantId/me/profile')
export class SelfProfileController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get()
  async read(@Req() req: AuthRequest, @Param('tenantId') tenantId: unknown) {
    const context = await readEmployeeSelfContext(this.auth, req, tenantId);
    return this.database.readSelfEmployeeProfile(
      context.actor,
      context.tenantId,
    );
  }
}
