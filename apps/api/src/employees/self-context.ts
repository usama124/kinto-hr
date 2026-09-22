import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { tenantIdSchema } from '@kinto/contracts';
import {
  assertSelectedTenant,
  readCookie,
  SESSION_COOKIE,
  type AuthRequest,
} from '../auth/controller';
import { AuthService } from '../auth/service';

export async function readEmployeeSelfContext(
  auth: AuthService,
  req: AuthRequest,
  tenantId: unknown,
) {
  const tenant = tenantIdSchema.safeParse(tenantId);
  if (!tenant.success) throw new BadRequestException();
  await auth.limit(req.socket.remoteAddress ?? 'unknown');
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new UnauthorizedException();
  const session = await auth.session(token);
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
