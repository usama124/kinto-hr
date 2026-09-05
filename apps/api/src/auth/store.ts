import { createHash, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { authenticatedIdentitySchema } from '@kinto/contracts';

export const IDLE_SECONDS = 30 * 60;
export const ABSOLUTE_SECONDS = 12 * 60 * 60;
export const LOGIN_SECONDS = 10 * 60;
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const loginSchema = z.strictObject({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
});
export type LoginTransaction = z.infer<typeof loginSchema>;
const sessionSchema = z.strictObject({
  principal: authenticatedIdentitySchema,
  identityId: z.uuid(),
  csrf: z.string(),
  authTime: z.number().int(),
  providerSessionId: z.string().min(1).max(255).optional(),
  selectedTenantId: z.uuid().optional(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  subjectIndex: z.string(),
  providerSessionIndex: z.string().optional(),
});
export type Session = z.infer<typeof sessionSchema>;

// The browser holds a random handle; Redis keys contain only its SHA-256 digest.
// Redis TIME keeps idle/absolute expiry consistent across API processes.
export class AuthStore {
  readonly redis: Redis;
  constructor(
    url: string,
    private readonly prefix = 'kinto:auth:v2:',
  ) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      commandTimeout: 3000,
      retryStrategy: () => null,
    });
    this.redis.on('error', () => {
      /* Never log connection strings or session data. */
    });
  }
  key(kind: string, token: string) {
    return `${this.prefix}${kind}:${digest(token)}`;
  }
  private index(kind: 'subject' | 'provider-session', value: string) {
    return `${this.prefix}${kind}:${digest(value)}`;
  }
  async connect() {
    await this.redis.connect();
  }
  close() {
    this.redis.disconnect();
  }
  async ready() {
    await this.redis.ping();
  }
  async allow(ip: string): Promise<boolean> {
    const count = await this.redis.eval(
      `
      local n = redis.call('INCR', KEYS[1])
      if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end
      return n`,
      1,
      this.key('rate', ip),
    );
    return Number(count) <= 60;
  }
  async saveLogin(token: string, login: LoginTransaction) {
    await this.redis.set(
      this.key('login', token),
      JSON.stringify(login),
      'EX',
      LOGIN_SECONDS,
    );
  }
  async takeLogin(token: string): Promise<LoginTransaction | undefined> {
    const value = await this.redis.getdel(this.key('login', token));
    return value ? loginSchema.parse(JSON.parse(value)) : undefined;
  }
  async createSession(
    data: Pick<
      Session,
      | 'principal'
      | 'identityId'
      | 'authTime'
      | 'providerSessionId'
      | 'selectedTenantId'
    >,
    oldToken?: string,
  ) {
    const token = opaqueToken();
    const csrf = opaqueToken();
    const raw = await this.redis.eval(
      `
      local function remove(key)
        local raw = redis.call('GET', key)
        if raw then
          local old = cjson.decode(raw)
          if old.subjectIndex then redis.call('SREM', old.subjectIndex, key) end
          if old.providerSessionIndex then redis.call('SREM', old.providerSessionIndex, key) end
        end
        redis.call('DEL', key)
      end
      local now = tonumber(redis.call('TIME')[1])
      local s = cjson.decode(ARGV[1])
      s.createdAt = now
      s.expiresAt = now + tonumber(ARGV[2])
      s.subjectIndex = KEYS[3]
      if ARGV[5] == 'yes' then s.providerSessionIndex = KEYS[4] end
      if ARGV[4] == 'yes' then remove(KEYS[2]) end
      local encoded = cjson.encode(s)
      redis.call('SET', KEYS[1], encoded, 'EX', ARGV[3])
      redis.call('SADD', KEYS[3], KEYS[1])
      redis.call('EXPIRE', KEYS[3], ARGV[2])
      if ARGV[5] == 'yes' then
        redis.call('SADD', KEYS[4], KEYS[1])
        redis.call('EXPIRE', KEYS[4], ARGV[2])
      end
      return encoded`,
      4,
      this.key('session', token),
      this.key('session', oldToken ?? token),
      this.index(
        'subject',
        `${data.principal.issuer}\0${data.principal.subject}`,
      ),
      this.index('provider-session', data.providerSessionId ?? token),
      JSON.stringify({ ...data, csrf }),
      ABSOLUTE_SECONDS,
      IDLE_SECONDS,
      oldToken ? 'yes' : 'no',
      data.providerSessionId ? 'yes' : 'no',
    );
    return { token, session: sessionSchema.parse(JSON.parse(String(raw))) };
  }
  async readSession(token: string): Promise<Session | undefined> {
    const raw = await this.redis.eval(
      `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return nil end
      local s = cjson.decode(raw)
      local now = tonumber(redis.call('TIME')[1])
      local remaining = s.expiresAt - now
      if remaining <= 0 then
        if s.subjectIndex then redis.call('SREM', s.subjectIndex, KEYS[1]) end
        if s.providerSessionIndex then redis.call('SREM', s.providerSessionIndex, KEYS[1]) end
        redis.call('DEL', KEYS[1])
        return nil
      end
      redis.call('EXPIRE', KEYS[1], math.min(remaining, tonumber(ARGV[1])))
      return raw`,
      1,
      this.key('session', token),
      IDLE_SECONDS,
    );
    return raw ? sessionSchema.parse(JSON.parse(String(raw))) : undefined;
  }
  async setSelectedTenant(
    token: string,
    tenantId?: string,
    expectedCsrf?: string,
  ) {
    const raw = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
      if not raw then return nil end
      local s = cjson.decode(raw)
      local now = tonumber(redis.call('TIME')[1])
      local remaining = s.expiresAt - now
      if remaining <= 0 then
        if s.subjectIndex then redis.call('SREM', s.subjectIndex, KEYS[1]) end
        if s.providerSessionIndex then redis.call('SREM', s.providerSessionIndex, KEYS[1]) end
        redis.call('DEL', KEYS[1])
        return nil
      end
      if ARGV[4] ~= '' and s.csrf ~= ARGV[4] then return nil end
      if ARGV[1] == '' then s.selectedTenantId = nil
      else s.selectedTenantId = ARGV[1] end
      s.csrf = ARGV[2]
      local encoded = cjson.encode(s)
      redis.call('SET', KEYS[1], encoded, 'EX', math.min(remaining, tonumber(ARGV[3])))
      return encoded`,
      1,
      this.key('session', token),
      tenantId ?? '',
      opaqueToken(),
      IDLE_SECONDS,
      expectedCsrf ?? '',
    );
    return raw ? sessionSchema.parse(JSON.parse(String(raw))) : undefined;
  }
  async deleteSession(token: string) {
    await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
      if raw then
        local s = cjson.decode(raw)
        if s.subjectIndex then redis.call('SREM', s.subjectIndex, KEYS[1]) end
        if s.providerSessionIndex then redis.call('SREM', s.providerSessionIndex, KEYS[1]) end
      end
      return redis.call('DEL', KEYS[1])`,
      1,
      this.key('session', token),
    );
  }
  async revokeProviderSessions(event: {
    jti: string;
    subject?: string;
    providerSessionId?: string;
    issuer: string;
  }) {
    const subject = this.index(
      'subject',
      `${event.issuer}\0${event.subject ?? event.jti}`,
    );
    const providerSession = this.index(
      'provider-session',
      event.providerSessionId ?? event.jti,
    );
    return Number(
      await this.redis.eval(
        `if not redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then return -1 end
        local members = {}
        local seen = {}
        local function include(index)
          for _, key in ipairs(redis.call('SMEMBERS', index)) do
            if not seen[key] then seen[key] = true; table.insert(members, key) end
          end
        end
        if ARGV[2] == 'yes' then include(KEYS[2]) end
        if ARGV[3] == 'yes' then include(KEYS[3]) end
        for _, key in ipairs(members) do
          local raw = redis.call('GET', key)
          if raw then
            local s = cjson.decode(raw)
            if s.subjectIndex then redis.call('SREM', s.subjectIndex, key) end
            if s.providerSessionIndex then redis.call('SREM', s.providerSessionIndex, key) end
            redis.call('DEL', key)
          end
        end
        if ARGV[2] == 'yes' then redis.call('DEL', KEYS[2]) end
        if ARGV[3] == 'yes' then redis.call('DEL', KEYS[3]) end
        return #members`,
        3,
        this.key('logout-replay', event.jti),
        subject,
        providerSession,
        300,
        event.subject ? 'yes' : 'no',
        event.providerSessionId ? 'yes' : 'no',
      ),
    );
  }
}
