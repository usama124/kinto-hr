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
import { SyntheticAttendanceInbox } from './synthetic-inbox';

@Injectable()
export class MachineService implements OnModuleInit, OnModuleDestroy {
  private readonly config = readMachineConfig(process.env);
  private authority?: LocalMachineAuthority;
  private inbox?: SyntheticAttendanceInbox;
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
    let inbox: SyntheticAttendanceInbox | undefined;
    try {
      inbox = new SyntheticAttendanceInbox(this.config.databaseUrl);
      await authority.connect();
      await inbox.ready();
      this.authority = authority;
      this.inbox = inbox;
    } catch {
      await Promise.allSettled([authority.close(), inbox?.close()]);
      throw new Error('Connector admission dependencies unavailable');
    }
  }
  async onModuleDestroy() {
    const authority = this.authority,
      inbox = this.inbox;
    this.authority = undefined;
    this.inbox = undefined;
    await Promise.all([authority?.close(), inbox?.close()]);
  }
  async ready() {
    if (this.config) {
      await this.resource().ready();
      await this.reviewResource().ready();
    }
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
  private reviewResource() {
    this.enabled();
    if (!this.inbox) throw new ServiceUnavailableException();
    return this.inbox;
  }
  reviewInbox(
    actor: OrganizationActor,
    tenant: string,
    device: string,
    query: unknown,
  ) {
    return this.reviewResource().review(actor, tenant, device, query);
  }
  previewInboxMapping(
    actor: OrganizationActor,
    tenant: string,
    device: string,
    event: string,
    query: unknown,
  ) {
    return this.reviewResource().previewMapping(
      actor,
      tenant,
      device,
      event,
      query,
    );
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
