import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Body,
  Get,
  Post,
  Put,
  Req,
  Res,
  Inject,
  HttpCode,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { tenantSelectionSchema } from '@kinto/contracts';
import { AuthService } from './service';
import { ABSOLUTE_SECONDS, LOGIN_SECONDS } from './store';

export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
  originalUrl: string;
}
export interface AuthResponse {
  setHeader(name: string, value: string | string[]): void;
  redirect(status: number, location: string): void;
  status(code: number): AuthResponse;
  end(): void;
}
export const SESSION_COOKIE = '__Host-kinto-session';
export const LOGIN_COOKIE = '__Host-kinto-login';
const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
export function readCookie(req: AuthRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  if (typeof header !== 'string') throw new UnauthorizedException();
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (!values.length) return undefined;
  if (values.length !== 1) throw new UnauthorizedException();
  const value = values[0].slice(name.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new UnauthorizedException();
  return value;
}
export function assertSessionMutation(
  req: AuthRequest,
  expectedOrigin: string,
  expectedCsrf: string,
) {
  if (req.headers.origin !== expectedOrigin) throw new ForbiddenException();
  const csrf = req.headers['x-csrf-token'];
  if (
    typeof csrf !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(csrf) ||
    !/^[A-Za-z0-9_-]{43}$/.test(expectedCsrf) ||
    !timingSafeEqual(Buffer.from(csrf), Buffer.from(expectedCsrf))
  )
    throw new ForbiddenException();
}
export function assertSelectedTenant(
  session: { selectedTenantId?: string },
  tenantId: string,
) {
  if (session.selectedTenantId !== tenantId) throw new ForbiddenException();
}
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private async limit(req: AuthRequest) {
    // Ignore forwarding headers. Deployment must add edge per-client limits;
    // behind a proxy this conservative limit applies to the whole proxy address.
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
  }
  @Get('login') async login(@Req() req: AuthRequest, @Res() res: AuthResponse) {
    await this.limit(req);
    const { url, token } = await this.auth.begin();
    res.setHeader('Set-Cookie', cookie(LOGIN_COOKIE, token, LOGIN_SECONDS));
    res.redirect(302, url);
  }
  @Get('callback') async callback(
    @Req() req: AuthRequest,
    @Res() res: AuthResponse,
  ) {
    await this.limit(req);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Set-Cookie', cookie(LOGIN_COOKIE, '', 0));
    const loginToken = readCookie(req, LOGIN_COOKIE);
    if (!loginToken) throw new UnauthorizedException();
    const offset = req.originalUrl.indexOf('?');
    const query = offset < 0 ? '' : req.originalUrl.slice(offset);
    const { token } = await this.auth.complete(
      query,
      loginToken,
      readCookie(req, SESSION_COOKIE),
    );
    res.setHeader('Set-Cookie', [
      cookie(LOGIN_COOKIE, '', 0),
      cookie(SESSION_COOKIE, token, ABSOLUTE_SECONDS),
    ]);
    res.redirect(303, `${this.auth.origin()}/login`);
  }
  @Get('session') async session(@Req() req: AuthRequest) {
    await this.limit(req);
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const { session, tenants } = await this.auth.access(token);
    // No provider tokens, subject, claims or roles reach the browser.
    return {
      identityId: session.identityId,
      csrfToken: session.csrf,
      expiresAt: session.expiresAt,
      selectedTenantId: session.selectedTenantId ?? null,
      tenants: tenants.map(({ id, name, roles }) => ({ id, name, roles })),
    };
  }
  @Put('tenant') async selectTenant(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    await this.limit(req);
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    const input = tenantSelectionSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const selected = await this.auth.selectTenant(
      token,
      input.data.tenantId,
      session.csrf,
    );
    return {
      selectedTenantId: selected.tenant.id,
      csrfToken: selected.session.csrf,
    };
  }
  @Post('logout') async logout(
    @Req() req: AuthRequest,
    @Res() res: AuthResponse,
  ) {
    await this.limit(req);
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const session = await this.auth.session(token);
    assertSessionMutation(req, this.auth.origin(), session.csrf);
    await this.auth.logout(token);
    res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
    res.status(204).end();
  }
  @Post('backchannel-logout')
  @HttpCode(204)
  async backchannelLogout(@Body('logout_token') logoutToken: unknown) {
    if (typeof logoutToken !== 'string') throw new UnauthorizedException();
    await this.auth.backchannelLogout(logoutToken);
  }
}
