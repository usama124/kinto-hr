import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { readProvisioningConfig, OWNER_INVITATION_SECONDS } from './config';
import { KeycloakProvisioner } from './keycloak';

@Injectable()
export class OwnerProvisioningService {
  private readonly config = readProvisioningConfig(process.env);
  private readonly provider = this.config
    ? new KeycloakProvisioner(this.config)
    : undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private async provision(
    requestId: string,
    email: string,
    reconcile: (
      requestId: string,
      providerIdentity: { issuer: string; subject: string },
      expiresAt: Date,
    ) => Promise<{
      status: string;
      expiresAt: Date;
    }>,
    markDelivered: (
      requestId: string,
      expiresAt: Date,
    ) => Promise<{ status: string }>,
  ) {
    if (!this.config || !this.provider) return undefined;
    const expiresAt = new Date(Date.now() + OWNER_INVITATION_SECONDS * 1000);
    try {
      const providerUser = await this.provider.reconcileUser(requestId, email);
      const invitation = await reconcile(
        requestId,
        { issuer: this.config.issuer, subject: providerUser.subject },
        expiresAt,
      );
      if (
        invitation.status === 'accepted' ||
        (invitation.status === 'pending_activation' &&
          invitation.expiresAt.getTime() > Date.now())
      )
        return {
          status:
            invitation.status === 'accepted' ? 'active' : 'pending_activation',
        };
      await this.provider.deliverActions(providerUser.subject);
      const delivered = await markDelivered(requestId, expiresAt);
      return { status: delivered.status };
    } catch {
      // Provider/DB partial failure never grants membership. The identical
      // approved request safely retries reconciliation and delivery.
      return { status: 'pending_identity_provider' };
    }
  }

  attempt(requestId: string, email: string) {
    return this.provision(
      requestId,
      email,
      this.database.reconcileCompanyOwner.bind(this.database),
      this.database.markOwnerInvitationDelivered.bind(this.database),
    );
  }

  attemptEmployee(requestId: string, email: string) {
    return this.provision(
      requestId,
      email,
      this.database.reconcileEmployeeAccount.bind(this.database),
      this.database.markEmployeeInvitationDelivered.bind(this.database),
    );
  }

  attemptAdministrator(requestId: string, email: string) {
    return this.provision(
      requestId,
      email,
      this.database.reconcileAdministrator.bind(this.database),
      this.database.markAdministratorInvitationDelivered.bind(this.database),
    );
  }
}
