import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { EnrollmentIssue, EnrollmentListQuery } from '@kinto/contracts';
import type { OrganizationActor } from '@kinto/database';
import { LocalMachineAuthority } from './local-machine-authority';
import { readMachineConfig } from './machine-config';

@Injectable()
export class MachineService implements OnModuleInit, OnModuleDestroy {
  private readonly config = readMachineConfig(process.env);
  private authority?: LocalMachineAuthority;
  enabled() {
    if (!this.config) throw new NotFoundException();
  }
  private resource() {
    this.enabled();
    if (!this.authority) throw new ServiceUnavailableException();
    return this.authority;
  }
  async onModuleInit() {
    if (!this.config) return;
    const authority = new LocalMachineAuthority(
      this.config.databaseUrl,
      this.config.redisUrl,
      this.config.namespace,
    );
    try {
      await authority.connect();
      this.authority = authority;
    } catch {
      await authority.close();
      throw new Error('Connector admission dependencies unavailable');
    }
  }
  async onModuleDestroy() {
    await this.authority?.close();
  }
  async ready() {
    if (this.config) await this.resource().ready();
  }
  async limit(ip: string) {
    try {
      if (!(await this.resource().allow(ip)))
        throw new HttpException('Try again later', 429);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException();
    }
  }
  issue(
    actor: OrganizationActor,
    tenant: string,
    key: string,
    input: EnrollmentIssue,
  ) {
    return this.resource().issue(actor, tenant, key, input);
  }
  enrollments(
    actor: OrganizationActor,
    tenant: string,
    input: EnrollmentListQuery,
  ) {
    return this.resource().enrollments(actor, tenant, input);
  }
  credentials(
    actor: OrganizationActor,
    tenant: string,
    input: EnrollmentListQuery,
  ) {
    return this.resource().credentials(actor, tenant, input);
  }
  revokeEnrollment(actor: OrganizationActor, tenant: string, id: string) {
    return this.resource().revokeEnrollment(actor, tenant, id);
  }
  revokeCredential(actor: OrganizationActor, tenant: string, id: string) {
    return this.resource().revokeCredential(actor, tenant, id);
  }
  redeem(token: string) {
    return this.resource().redeem(token);
  }
  authorize(credential: string) {
    return this.resource().authorize(credential);
  }
}
