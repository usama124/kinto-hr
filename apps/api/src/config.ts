import { z } from 'zod';
export function readConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      databaseUrl: z
        .url()
        .refine(
          (url) => ['postgres:', 'postgresql:'].includes(new URL(url).protocol),
          'PostgreSQL URL required',
        ),
      port: z.coerce.number().int().min(1024).max(65535),
      host: z.enum(['127.0.0.1', '0.0.0.0']),
    })
    .parse({
      databaseUrl: env.DATABASE_URL,
      port: env.API_PORT ?? 4000,
      host: env.API_HOST ?? '127.0.0.1',
    });
}
