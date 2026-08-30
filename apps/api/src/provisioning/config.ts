import { z } from 'zod';

export const OWNER_INVITATION_SECONDS = 48 * 60 * 60;

export function readProvisioningConfig(env: NodeJS.ProcessEnv) {
  const mode = z
    .enum(['disabled', 'keycloak'])
    .parse(env.ACCOUNT_PROVISIONING_MODE ?? 'disabled');
  if (mode === 'disabled') return undefined;
  if (env.AUTH_MODE !== 'oidc' || env.OIDC_MFA_PROFILE !== 'keycloak-loa2-v1')
    throw new Error('Keycloak provisioning requires trusted OIDC MFA');
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
  });
  const parsed = z
    .object({
      issuer: endpoint,
      origin: endpoint.refine((value) => new URL(value).pathname === '/'),
      loginClientId: z.string().trim().min(1).max(255),
      managementClientId: z.string().trim().min(1).max(255),
      managementClientSecret: z.string().min(16),
    })
    .parse({
      issuer: env.OIDC_ISSUER,
      origin: env.AUTH_ORIGIN,
      loginClientId: env.OIDC_CLIENT_ID,
      managementClientId: env.KEYCLOAK_PROVISIONING_CLIENT_ID,
      managementClientSecret: env.KEYCLOAK_PROVISIONING_CLIENT_SECRET,
    });
  const issuer = new URL(parsed.issuer);
  const match = /^\/realms\/([^/]+)$/.exec(issuer.pathname);
  if (!match) throw new Error('Keycloak realm issuer required');
  const realm = decodeURIComponent(match[1]);
  if (!realm || realm.length > 255) throw new Error('Invalid Keycloak realm');
  return {
    ...parsed,
    origin: new URL(parsed.origin).origin,
    tokenUrl: new URL(
      `${issuer.pathname}/protocol/openid-connect/token`,
      issuer.origin,
    ).href,
    adminBaseUrl: new URL(
      `/admin/realms/${encodeURIComponent(realm)}`,
      issuer.origin,
    ).href.replace(/\/$/, ''),
  };
}
export type ProvisioningConfig = NonNullable<
  ReturnType<typeof readProvisioningConfig>
>;
