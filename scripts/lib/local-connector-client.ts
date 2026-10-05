import { request } from 'node:http';
import { z } from 'zod';
import {
  connectorHeartbeatResultSchema,
  connectorRecordSchema,
  connectorRedemptionRequestSchema,
  connectorRedemptionResultSchema,
} from '@kinto/contracts';

type Connector = z.infer<typeof connectorRecordSchema>;
type State =
  'idle' | 'redeeming' | 'active' | 'uncertain' | 'denied' | 'stopped';
const bindingSchema = z.strictObject({
  tenantId: z.uuid(),
  deviceId: z.uuid(),
  enrollmentId: z.uuid(),
});
type Binding = z.infer<typeof bindingSchema>;

/** Synthetic reference client, not the selected K50 SDK runtime or a host service. */
export class LocalConnectorClient {
  #state: State = 'idle';
  #credential?: string;
  #connector?: Connector;
  #pending?: AbortController;
  readonly #base: URL;
  readonly #binding: Binding;
  readonly #timeout: number;

  constructor(options: {
    mode: 'local_test';
    baseUrl: string;
    binding: Binding;
    timeoutMs?: number;
  }) {
    if (options.mode !== 'local_test' || process.env.NODE_ENV === 'production')
      throw new Error('Local connector client unavailable');
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new Error('Invalid local connector endpoint');
    }
    // Literal IPv4 only: no DNS, redirect, proxy or remote destination support.
    if (
      base.protocol !== 'http:' ||
      base.hostname !== '127.0.0.1' ||
      !base.port ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw new Error('Invalid local connector endpoint');
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 30000)
      throw new Error('Invalid connector timeout');
    this.#base = base;
    this.#binding = bindingSchema.parse(options.binding);
    this.#timeout = timeout;
  }

  get state(): State {
    return this.#state;
  }

  get connector(): Connector | null {
    return this.#connector ? { ...this.#connector } : null;
  }

  stop() {
    this.#state = 'stopped';
    this.#credential = undefined;
    this.#connector = undefined;
    this.#pending?.abort();
  }

  #bound(connector: Connector) {
    return (
      connector.tenantId === this.#binding.tenantId &&
      connector.deviceId === this.#binding.deviceId &&
      connector.enrollmentId === this.#binding.enrollmentId &&
      (!this.#connector ||
        (connector.id === this.#connector.id &&
          connector.createdAt === this.#connector.createdAt &&
          connector.expiresAt === this.#connector.expiresAt)) &&
      connector.status === 'active' &&
      Date.parse(connector.createdAt) <= Date.now() &&
      Date.parse(connector.expiresAt) > Date.now()
    );
  }

  // No retries. In particular, a lost redemption reply must be reconciled by HR.
  async redeem(token: string): Promise<void> {
    if (this.#state !== 'idle') throw new Error('Enrollment unavailable');
    if (!connectorRedemptionRequestSchema.safeParse({ token }).success)
      throw new Error('Invalid enrollment token');
    this.#state = 'redeeming';
    try {
      const result = await this.#post('redemption', { token });
      const parsed = connectorRedemptionResultSchema.safeParse(result.body);
      if (
        result.status !== 201 ||
        !parsed.success ||
        !this.#bound(parsed.data.connector)
      )
        throw new Error('Invalid enrollment response');
      if (this.state === 'stopped') throw new Error('Stopped');
      this.#credential = parsed.data.credential;
      this.#connector = parsed.data.connector;
      this.#state = 'active';
    } catch {
      if (this.state !== 'stopped') this.#state = 'uncertain';
      throw new Error(
        'Enrollment not confirmed; inspect and revoke before re-enrolling',
      );
    }
  }

  async heartbeat(): Promise<void> {
    if (this.#state !== 'active' || this.#pending || !this.#credential)
      throw new Error('Heartbeat unavailable');
    if (
      !this.#connector ||
      Date.parse(this.#connector.expiresAt) <= Date.now()
    ) {
      this.#deny();
      throw new Error('Connector authorization ended');
    }
    try {
      const result = await this.#post('heartbeat', {}, this.#credential);
      if (this.state === 'stopped') throw new Error('Stopped');
      if ([401, 403, 404].includes(result.status)) this.#deny();
      if (result.status !== 200) throw new Error('Heartbeat rejected');
      const parsed = connectorHeartbeatResultSchema.safeParse(result.body);
      if (!parsed.success || !this.#bound(parsed.data.connector)) {
        this.#deny();
        throw new Error('Invalid heartbeat response');
      }
      this.#connector = parsed.data.connector;
    } catch {
      throw new Error('Heartbeat not confirmed');
    }
  }

  #deny() {
    this.#state = 'denied';
    this.#credential = undefined;
    this.#connector = undefined;
  }

  async #post(path: string, body: object, credential?: string) {
    const controller = new AbortController();
    this.#pending = controller;
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      return await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const req = request(
            new URL(`/api/v1/local-machine/connectors/${path}`, this.#base),
            {
              method: 'POST',
              agent: false,
              signal: controller.signal,
              headers: {
                'content-type': 'application/json',
                ...(credential
                  ? { authorization: `Bearer ${credential}` }
                  : {}),
              },
            },
            (res) => {
              let size = 0;
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 16384) {
                  res.destroy();
                  reject(new Error('Response too large'));
                } else chunks.push(chunk);
              });
              res.on('error', reject);
              res.on('aborted', () =>
                reject(new Error('Response interrupted')),
              );
              res.on('end', () => {
                // Never expose server diagnostics, redirect targets or secret echoes.
                try {
                  const status = res.statusCode ?? 0;
                  resolve({
                    status,
                    body:
                      status === 200 || status === 201
                        ? (JSON.parse(
                            Buffer.concat(chunks).toString('utf8'),
                          ) as unknown)
                        : null,
                  });
                } catch {
                  reject(new Error('Invalid response'));
                }
              });
            },
          );
          req.on('error', reject);
          req.end(JSON.stringify(body));
        },
      );
    } finally {
      clearTimeout(timer);
      if (this.#pending === controller) this.#pending = undefined;
    }
  }
}
