jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    WorkRepository: class {},
}));
jest.mock('@ever-works/agent/config', () => ({ config: { githubApp: {} } }));
jest.mock('@ever-works/agent/utils', () => ({}));

import {
    BadGatewayException,
    ConflictException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { SiteGitTokenController } from './site-git-token.controller';
import { SiteGitTokenError } from './site-git-token.service';

describe('SiteGitTokenController', () => {
    const minted = {
        token: 'ghs_scoped',
        expiresAt: '2026-11-07T12:00:00.000Z',
        repository: 'ever-works/acme-data',
    };
    const build = (impl: jest.Mock) => {
        const service = { mintForSite: impl };
        return { controller: new SiteGitTokenController(service as any), service };
    };

    it('returns the minted token for a valid bearer secret', async () => {
        const { controller, service } = build(jest.fn().mockResolvedValue(minted));
        await expect(controller.mint('work-1', 'Bearer ewsgt_abc')).resolves.toEqual(minted);
        expect(service.mintForSite).toHaveBeenCalledWith('work-1', 'ewsgt_abc');
    });

    it.each([[undefined], [''], ['Basic abc'], ['Bearer ']])(
        'answers 401 for the authorization header %p without calling the service',
        async (header) => {
            const { controller, service } = build(jest.fn());
            await expect(controller.mint('work-1', header)).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
            expect(service.mintForSite).not.toHaveBeenCalled();
        },
    );

    it('answers 401 for a malformed Work id', async () => {
        const { controller, service } = build(jest.fn());
        await expect(controller.mint('../etc', 'Bearer x')).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
        expect(service.mintForSite).not.toHaveBeenCalled();
    });

    it('answers 401 when the service does not recognise the site', async () => {
        const { controller } = build(jest.fn().mockResolvedValue(null));
        await expect(controller.mint('work-1', 'Bearer x')).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
    });

    it.each([
        ['disabled', ServiceUnavailableException],
        ['not-configured', ServiceUnavailableException],
        ['mint-failed', BadGatewayException],
        ['unmanaged-owner', ConflictException],
        ['no-installation', ConflictException],
        ['invalid-repository', ConflictException],
    ] as const)('maps %s to %p', async (reason, type) => {
        const { controller } = build(jest.fn().mockRejectedValue(new SiteGitTokenError(reason)));
        await expect(controller.mint('work-1', 'Bearer x')).rejects.toBeInstanceOf(type);
    });

    it('lets an unexpected error through', async () => {
        const { controller } = build(jest.fn().mockRejectedValue(new Error('boom')));
        await expect(controller.mint('work-1', 'Bearer x')).rejects.toThrow('boom');
    });
});
