import {
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  ServiceUnavailableException,
  HttpException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { readAuthConfig } from './config';
import { OidcProvider } from './oidc';
import { AuthStore, opaqueToken, digest } from './store';

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly config = readAuthConfig(process.env);
  private store?: AuthStore;
  private provider?: OidcProvider;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  async onModuleInit() {
    if (!this.config) return;
    this.store = new AuthStore(
      this.config.redisUrl,
      `kinto:auth:v2:${digest(`${this.config.issuer}|${this.config.clientId}|${this.config.origin}`)}:`,
    );
    try {
      await this.store.connect();
      this.provider = await OidcProvider.connect(this.config);
    } catch {
      this.store.close();
      throw new Error('Authentication dependencies unavailable');
    }
  }
  onModuleDestroy() {
    this.store?.close();
  }
  async ready() {
    if (this.config) await this.resources().store.ready();
  }
  private resources() {
    if (!this.config) throw new NotFoundException();
    if (!this.store || !this.provider) throw new ServiceUnavailableException();
    return { config: this.config, store: this.store, provider: this.provider };
  }
  origin() {
    return this.resources().config.origin;
  }
  async limit(ip: string) {
    if (!(await this.resources().store.allow(ip)))
      throw new HttpException('Try again later', 429);
  }
  async begin() {
    const { store, provider } = this.resources();
    const { url, transaction } = await provider.begin();
    const token = opaqueToken();
    await store.saveLogin(token, transaction);
    return { url, token };
  }
  async complete(query: string, loginToken: string, oldSession?: string) {
    const { store, provider, config } = this.resources();
    const transaction = await store.takeLogin(loginToken);
    if (!transaction) throw new UnauthorizedException();
    let verified;
    try {
      verified = await provider.complete(
        new URL(`${config.origin}/api/v1/auth/callback${query}`),
        transaction,
      );
    } catch {
      throw new UnauthorizedException();
    }
    const identity = await this.database.findIdentity(verified.principal);
    if (!identity) throw new UnauthorizedException();
    const tenants = await this.database.discoverTenants(identity.id);
    return store.createSession(
      {
        ...verified,
        identityId: identity.id,
        ...(tenants.length === 1 ? { selectedTenantId: tenants[0].id } : {}),
      },
      oldSession,
    );
  }
  async access(token: string) {
    const { store } = this.resources();
    let session = await store.readSession(token);
    if (!session) throw new UnauthorizedException();
    const identity = await this.database.findIdentity(session.principal);
    if (!identity || identity.id !== session.identityId) {
      await store.deleteSession(token);
      throw new UnauthorizedException();
    }
    const tenants = await this.database.discoverTenants(identity.id);
    const selectedTenantId = session.selectedTenantId;
    if (
      selectedTenantId &&
      !tenants.some((tenant) => tenant.id === selectedTenantId)
    ) {
      const updated = await store.setSelectedTenant(token);
      if (!updated) throw new UnauthorizedException();
      session = updated;
    }
    return { session, tenants };
  }
  async session(token: string) {
    return (await this.access(token)).session;
  }
  async selectTenant(token: string, tenantId: string, expectedCsrf: string) {
    const { store } = this.resources();
    const { tenants } = await this.access(token);
    const tenant = tenants.find((candidate) => candidate.id === tenantId);
    if (!tenant) throw new ForbiddenException();
    const session = await store.setSelectedTenant(
      token,
      tenantId,
      expectedCsrf,
    );
    if (!session) throw new ForbiddenException();
    return { session, tenant };
  }
  async logout(token: string) {
    await this.resources().store.deleteSession(token);
  }
  async backchannelLogout(token: string) {
    const { store, provider } = this.resources();
    let logout;
    try {
      logout = await provider.verifyLogoutToken(token);
    } catch {
      throw new UnauthorizedException();
    }
    await store.revokeProviderSessions({
      jti: logout.jti,
      subject: logout.sub,
      providerSessionId: logout.sid,
      issuer: logout.iss,
    });
  }
}
