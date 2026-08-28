import { z } from 'zod';

export function readAuthConfig(env: NodeJS.ProcessEnv) {
  const mode = z.enum(['disabled', 'oidc']).parse(env.AUTH_MODE ?? 'disabled');
  if (mode === 'disabled') return undefined;
  const local = ['development', 'test'].includes(env.NODE_ENV ?? '');
  const endpoint = z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (local &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'HTTPS required except explicit local development/test');
  const config = z
    .object({
      issuer: endpoint,
      origin: endpoint.refine((value) => new URL(value).pathname === '/'),
      clientId: z.string().trim().min(1).max(255),
      clientSecret: z.string().min(16),
      redisUrl: z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'rediss:' ||
          (local &&
            url.protocol === 'redis:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        );
      }),
    })
    .parse({
      issuer: env.OIDC_ISSUER,
      origin: env.AUTH_ORIGIN,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redisUrl: env.AUTH_REDIS_URL,
    });
  return { ...config, origin: new URL(config.origin).origin, local };
}
export type AuthConfig = NonNullable<ReturnType<typeof readAuthConfig>>;
