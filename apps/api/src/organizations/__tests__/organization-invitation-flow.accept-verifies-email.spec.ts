import { ForbiddenException } from '@nestjs/common';

// Same module-scope stubs as `organization-invitation-flow.service.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({
    OrganizationInvitationService: class OrganizationInvitationService {
        static normaliseEmail(email: string): string {
            return email.trim().toLowerCase();
        }
    },
}));
jest.mock('@ever-works/agent/database', () => ({
    OrganizationMemberRepository: class OrganizationMemberRepository {},
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('../../scope/tenant-bootstrap.service', () => ({
    TenantBootstrapService: class TenantBootstrapService {},
}));
jest.mock('../../mail/mail.service', () => ({ MailService: class MailService {} }));
jest.mock('../../config/constants', () => ({
    config: { webAppUrl: () => 'https://app.test' },
}));
jest.mock('../organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));

import { OrganizationInvitationFlowService } from '../organization-invitation-flow.service';
import { UserConfirmedEvent } from '../../events';

/**
 * `accept()` marks the redeemer's email verified: the raw token was only ever mailed to the
 * invitation address and `findConsumable` binds it to the signed-in user's address, so a
 * successful accept proves the mailbox. A failed accept must never verify anything.
 */
const ORG = { id: 'org-1', tenantId: 'ten-1', slug: 'acme' };
const INVITATION = {
    id: 'inv-1',
    organizationId: 'org-1',
    tenantId: 'ten-1',
    email: 'Ada@Example.com',
    invitedById: 'u-owner',
};

function build(
    opts: {
        user?: Record<string, unknown>;
        consumable?: () => Promise<unknown>;
    } = {},
) {
    const user = { id: 'u-1', email: 'ada@example.com', emailVerified: false, ...opts.user };
    const invitations = {
        findConsumable: jest.fn(opts.consumable ?? (() => Promise.resolve(INVITATION))),
        tryAccept: jest.fn().mockResolvedValue(true),
        findById: jest.fn(),
    };
    const members = {
        findByOrgAndUser: jest.fn().mockResolvedValue({ id: 'm-1' }),
        create: jest.fn(),
    };
    const organizations = { findById: jest.fn().mockResolvedValue(ORG) };
    const users = {
        findById: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(undefined),
    };
    const tenantBootstrap = { joinTenant: jest.fn().mockResolvedValue('joined') };
    const eventEmitter = { emit: jest.fn() };
    const service = new OrganizationInvitationFlowService(
        invitations as never,
        members as never,
        organizations as never,
        users as never,
        {} as never,
        tenantBootstrap as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        eventEmitter as never,
    );
    return { service, users, invitations, tenantBootstrap, eventEmitter };
}

describe('OrganizationInvitationFlowService.accept - email verification', () => {
    it('verifies an unverified user whose address is the invitation address (case-insensitive)', async () => {
        const { service, users, eventEmitter } = build();
        users.findById
            .mockResolvedValueOnce({ id: 'u-1', email: ' ADA@example.com ', emailVerified: false })
            .mockResolvedValueOnce({ id: 'u-1', email: 'ada@example.com', emailVerified: true });

        const outcome = await service.accept('tok', 'u-1');

        expect(outcome.joined).toBe(true);
        expect(users.update).toHaveBeenCalledTimes(1);
        expect(users.update).toHaveBeenCalledWith('u-1', { emailVerified: true });
        // Same welcome event `POST /auth/verify-email` emits on the flip.
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            UserConfirmedEvent.EVENT_NAME,
            expect.any(UserConfirmedEvent),
        );
    });

    it('leaves an already-verified user unchanged', async () => {
        const { service, users, eventEmitter } = build({ user: { emailVerified: true } });

        await service.accept('tok', 'u-1');

        expect(users.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('never verifies when the token is wrong or the email does not match', async () => {
        const { service, users, tenantBootstrap, eventEmitter } = build({
            consumable: () => Promise.reject(new ForbiddenException('invitation_email_mismatch')),
        });

        await expect(service.accept('bad', 'u-1')).rejects.toBeInstanceOf(ForbiddenException);

        expect(tenantBootstrap.joinTenant).not.toHaveBeenCalled();
        expect(users.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('never verifies when the claim is lost', async () => {
        const { service, users, invitations } = build();
        invitations.tryAccept.mockResolvedValue(false);
        invitations.findById.mockResolvedValue({ acceptedByUserId: 'someone-else' });

        await expect(service.accept('tok', 'u-1')).rejects.toThrow('invitation_state_changed');

        expect(users.update).not.toHaveBeenCalled();
    });

    it('does not turn a failed verification write into a failed accept', async () => {
        const { service, users } = build();
        users.update.mockRejectedValue(new Error('db down'));

        await expect(service.accept('tok', 'u-1')).resolves.toMatchObject({ joined: true });
    });
});
