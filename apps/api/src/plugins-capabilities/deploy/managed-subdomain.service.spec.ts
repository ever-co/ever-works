jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class {},
}));
jest.mock('@ever-works/agent/ever-works-providers', () => ({
    EverWorksDnsService: class {},
    SubdomainAllocator: class {},
    // The real reserved list + conflict error: a dependency-free module.
    ...jest.requireActual(
        '../../../../../packages/agent/src/ever-works-providers/managed-subdomain-guard',
    ),
}));
jest.mock('@ever-works/agent/entities', () => ({
    Work: class {},
}));

import {
    BadRequestException,
    ConflictException,
    InternalServerErrorException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ManagedSubdomainService } from './managed-subdomain.service';
import type { WorkRepository } from '@ever-works/agent/database';
import {
    DnsRecordConflictError,
    type EverWorksDnsService,
} from '@ever-works/agent/ever-works-providers';

describe('ManagedSubdomainService', () => {
    let workRepository: {
        findById: jest.Mock;
        findByManagedSubdomain: jest.Mock;
        update: jest.Mock;
    };
    let provider: {
        rootDomain: jest.Mock;
        recordExists: jest.Mock;
        ensureRecord: jest.Mock;
        removeRecord: jest.Mock;
    };
    let dnsService: { getProvider: jest.Mock; getZoneProbe: jest.Mock };
    let service: ManagedSubdomainService;
    /** Hostnames with an A/CNAME record in the fake zone the provider mock reads and writes. */
    let zone: Set<string>;

    const buildWork = (overrides: Record<string, unknown> = {}) => ({
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'my-site',
        name: 'My Site',
        deployProvider: 'ever-works',
        managedSubdomain: null,
        ...overrides,
    });

    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            EVER_WORKS_DEPLOY_LB_HOSTNAME: 'lb.ever.works',
            K8S_MANAGED_SUBDOMAIN: 'false',
            EVER_WORKS_DOMAIN: 'ever.works',
        };
        workRepository = {
            findById: jest.fn(),
            findByManagedSubdomain: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue(undefined),
        };
        zone = new Set(['my-site.ever.works', 'old-name.ever.works']);
        provider = {
            rootDomain: jest.fn().mockReturnValue('ever.works'),
            recordExists: jest.fn(async (host: string) => zone.has(host)),
            ensureRecord: jest.fn(async ({ host }: { host: string }) => {
                zone.add(host);
                return { id: 'rec-1' };
            }),
            removeRecord: jest.fn(async ({ host }: { host: string }) => {
                zone.delete(host);
            }),
        };
        dnsService = {
            getProvider: jest.fn().mockReturnValue(provider),
            getZoneProbe: jest.fn().mockReturnValue(provider),
        };
        service = new ManagedSubdomainService(
            workRepository as unknown as WorkRepository,
            dnsService as unknown as EverWorksDnsService,
        );
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    describe('getState', () => {
        it('throws 404 when the work does not exist', async () => {
            workRepository.findById.mockResolvedValue(null);

            await expect(service.getState('missing')).rejects.toBeInstanceOf(NotFoundException);
        });

        it('returns the unallocated shape when managedSubdomain is null', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: null }));

            const result = await service.getState('work-1');

            expect(result).toEqual({
                subdomain: null,
                fqdn: null,
                url: null,
                recordOk: false,
                editable: true, // ever-works provider
            });
            expect(provider.recordExists).not.toHaveBeenCalled();
        });

        it('returns the allocated shape with recordOk=true when the probe succeeds', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'my-site' }));

            const result = await service.getState('work-1');

            expect(provider.recordExists).toHaveBeenCalledWith('my-site.ever.works');
            expect(result).toEqual({
                subdomain: 'my-site',
                fqdn: 'my-site.ever.works',
                url: 'https://my-site.ever.works',
                recordOk: true,
                editable: true,
            });
        });

        it('returns recordOk=false (and no throw) when the probe fails', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'my-site' }));
            provider.recordExists.mockRejectedValue(new Error('Cloudflare down'));

            const result = await service.getState('work-1');

            expect(result.recordOk).toBe(false);
            expect(result.subdomain).toBe('my-site');
        });

        it('sets editable=false for non-managed providers (vercel)', async () => {
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'vercel', managedSubdomain: 'my-site' }),
            );

            const result = await service.getState('work-1');

            expect(result.editable).toBe(false);
        });

        it('sets editable=true for k8s only when K8S_MANAGED_SUBDOMAIN=true', async () => {
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'k8s', managedSubdomain: 'my-site' }),
            );

            process.env.K8S_MANAGED_SUBDOMAIN = 'false';
            expect((await service.getState('work-1')).editable).toBe(false);

            process.env.K8S_MANAGED_SUBDOMAIN = 'true';
            expect((await service.getState('work-1')).editable).toBe(true);
        });

        it('falls back to env EVER_WORKS_DOMAIN when DNS is not configured', async () => {
            dnsService.getProvider.mockReturnValue(null);
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'my-site' }));

            const result = await service.getState('work-1');

            expect(result.fqdn).toBe('my-site.ever.works');
            // No provider means we can't probe; recordOk stays false.
            expect(result.recordOk).toBe(false);
        });
    });

    describe('update', () => {
        it('rejects invalid subdomain format (leading dash)', async () => {
            await expect(service.update('work-1', '-bad')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('normalizes case + whitespace before persisting (BadCase → badcase)', async () => {
            const workBefore = buildWork({ managedSubdomain: null });
            workRepository.findById
                .mockResolvedValueOnce(workBefore)
                .mockResolvedValueOnce({ ...workBefore, managedSubdomain: 'badcase' });

            await service.update('work-1', '  BadCase  ');

            expect(workRepository.update).toHaveBeenCalledWith(workBefore.id, {
                managedSubdomain: 'badcase',
            });
        });

        it('rejects characters outside [a-z0-9-]', async () => {
            await expect(service.update('work-1', 'bad_name')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.update('work-1', 'bad.name')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects labels longer than 63 chars', async () => {
            await expect(service.update('work-1', 'a'.repeat(64))).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects blocklisted labels (www, api, app, admin, mail)', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ deployProvider: 'ever-works' }));
            for (const reserved of ['www', 'api', 'app', 'admin', 'mail']) {
                await expect(service.update('work-1', reserved)).rejects.toMatchObject({
                    response: {
                        message: expect.stringContaining('reserved'),
                    },
                });
            }
        });

        it('rejects when the work is not editable (vercel provider)', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ deployProvider: 'vercel' }));

            await expect(service.update('work-1', 'good-name')).rejects.toMatchObject({
                response: { message: expect.stringContaining('not editable') },
            });
        });

        it('short-circuits when requested matches current (idempotent rename)', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'my-site' }));

            await service.update('work-1', 'my-site');

            // Critical: no DNS mutation and no DB write when the value is unchanged.
            expect(workRepository.update).not.toHaveBeenCalled();
            expect(provider.ensureRecord).not.toHaveBeenCalled();
            expect(provider.removeRecord).not.toHaveBeenCalled();
        });

        it('rejects with 409 Conflict when subdomain is claimed by a different work', async () => {
            workRepository.findById.mockResolvedValue(buildWork());
            workRepository.findByManagedSubdomain.mockResolvedValue({
                id: 'other-work',
                managedSubdomain: 'taken',
            });

            await expect(service.update('work-1', 'taken')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('allows the rename when findByManagedSubdomain returns the same work (self-claim)', async () => {
            const work = buildWork({ managedSubdomain: 'old-name' });
            workRepository.findById.mockResolvedValue(work);
            workRepository.findByManagedSubdomain.mockResolvedValue(work);

            await service.update('work-1', 'new-name');

            expect(workRepository.update).toHaveBeenCalledWith(work.id, {
                managedSubdomain: 'new-name',
            });
        });

        it('returns 500 when DNS provider is not configured', async () => {
            dnsService.getProvider.mockReturnValue(null);
            workRepository.findById.mockResolvedValue(buildWork());

            await expect(service.update('work-1', 'good-name')).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('returns 500 when LB hostname env is missing', async () => {
            process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = '';
            workRepository.findById.mockResolvedValue(buildWork());

            await expect(service.update('work-1', 'good-name')).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('happy path: removes old, persists, ensures new, returns refreshed state', async () => {
            const workBefore = buildWork({ managedSubdomain: 'old-name' });
            const workAfter = { ...workBefore, managedSubdomain: 'new-name' };
            workRepository.findById
                .mockResolvedValueOnce(workBefore) // update()
                .mockResolvedValueOnce(workAfter); // post-update getState()

            const result = await service.update('work-1', 'new-name');

            expect(provider.removeRecord).toHaveBeenCalledWith({
                host: 'old-name.ever.works',
            });
            expect(workRepository.update).toHaveBeenCalledWith(workBefore.id, {
                managedSubdomain: 'new-name',
            });
            expect(provider.ensureRecord).toHaveBeenCalledWith({
                host: 'new-name.ever.works',
                type: 'CNAME',
                target: 'lb.ever.works',
                proxied: false,
                ttl: 1,
            });
            // Order: persist → ensure new → remove old, so a failed ensure
            // rolls back to a label whose record still exists.
            const removeOrder = provider.removeRecord.mock.invocationCallOrder[0];
            const updateOrder = workRepository.update.mock.invocationCallOrder[0];
            const ensureOrder = provider.ensureRecord.mock.invocationCallOrder[0];
            expect(updateOrder).toBeLessThan(ensureOrder);
            expect(ensureOrder).toBeLessThan(removeOrder);

            expect(result.subdomain).toBe('new-name');
        });

        it('does NOT call removeRecord when there is no prior subdomain', async () => {
            const workBefore = buildWork({ managedSubdomain: null });
            workRepository.findById
                .mockResolvedValueOnce(workBefore)
                .mockResolvedValueOnce({ ...workBefore, managedSubdomain: 'first-name' });

            await service.update('work-1', 'first-name');

            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(provider.ensureRecord).toHaveBeenCalled();
        });

        it('proceeds (best-effort) even when removeRecord on the old name throws', async () => {
            const workBefore = buildWork({ managedSubdomain: 'old-name' });
            workRepository.findById
                .mockResolvedValueOnce(workBefore)
                .mockResolvedValueOnce({ ...workBefore, managedSubdomain: 'new-name' });
            provider.removeRecord.mockRejectedValue(new Error('cf down'));

            await service.update('work-1', 'new-name');

            expect(workRepository.update).toHaveBeenCalled();
            expect(provider.ensureRecord).toHaveBeenCalled();
        });

        it('maps a unique-violation on persist to 409 Conflict', async () => {
            workRepository.findById.mockResolvedValue(buildWork());
            workRepository.update.mockRejectedValue({ code: '23505' });

            await expect(service.update('work-1', 'race-loser')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('rolls back the persisted claim when ensureRecord fails after persist', async () => {
            const workBefore = buildWork({ managedSubdomain: 'old-name' });
            workRepository.findById.mockResolvedValue(workBefore);
            provider.ensureRecord.mockRejectedValue(new Error('cf api down'));

            await expect(service.update('work-1', 'new-name')).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );

            // Two updates: forward to 'new-name', rollback to 'old-name'.
            expect(workRepository.update).toHaveBeenNthCalledWith(1, workBefore.id, {
                managedSubdomain: 'new-name',
            });
            expect(workRepository.update).toHaveBeenNthCalledWith(2, workBefore.id, {
                managedSubdomain: 'old-name',
            });
            // The rolled-back label still resolves: its record was never removed.
            expect(provider.removeRecord).not.toHaveBeenCalledWith({
                host: 'old-name.ever.works',
            });
            expect(zone.has('old-name.ever.works')).toBe(true);
        });

        it('refuses with 409 a hostname that already exists in the zone, before any write', async () => {
            // One of the zone's other hosts, not claimed by any Work in the DB.
            zone.add('existing-host.ever.works');
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'old-name' }));

            await expect(service.update('work-1', 'existing-host')).rejects.toMatchObject({
                status: 409,
                response: { message: expect.stringContaining('already in use') },
            });

            expect(provider.recordExists).toHaveBeenCalledWith('existing-host.ever.works');
            // No PATCH/PUT of the existing record, no cleanup, no DB claim.
            expect(provider.ensureRecord).not.toHaveBeenCalled();
            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
            expect(zone.has('old-name.ever.works')).toBe(true);
        });

        it("treats the Work's own current record as OK (idempotent, no probe, no write)", async () => {
            const work = buildWork({ managedSubdomain: 'my-site' });
            workRepository.findById.mockResolvedValue(work);

            const result = await service.update('work-1', ' My-Site ');

            expect(result).toMatchObject({ subdomain: 'my-site', recordOk: true });
            // The only zone read is getState's health probe.
            expect(provider.recordExists).toHaveBeenCalledTimes(1);
            expect(provider.ensureRecord).not.toHaveBeenCalled();
            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it.each(['mcp', 'lb', 'api-dev', 'appstage', 'docs-stage'])(
            'rejects the reserved name %s with 400 before touching the zone',
            async (reserved) => {
                workRepository.findById.mockResolvedValue(buildWork());

                await expect(service.update('work-1', reserved)).rejects.toBeInstanceOf(
                    BadRequestException,
                );
                expect(provider.recordExists).not.toHaveBeenCalled();
                expect(provider.ensureRecord).not.toHaveBeenCalled();
                expect(workRepository.update).not.toHaveBeenCalled();
            },
        );

        it('fails closed (503) when the zone cannot be read', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'old-name' }));
            provider.recordExists.mockRejectedValue(new Error('cf api down'));

            await expect(service.update('work-1', 'new-name')).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(provider.ensureRecord).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('maps a provider refusal to repoint (record appeared after the probe) to 409 and rolls back', async () => {
            const workBefore = buildWork({ managedSubdomain: null });
            workRepository.findById.mockResolvedValue(workBefore);
            provider.ensureRecord.mockRejectedValue(
                new DnsRecordConflictError('late.ever.works', 'CNAME', 'other.example.net'),
            );

            await expect(service.update('work-1', 'late')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(workRepository.update).toHaveBeenNthCalledWith(1, workBefore.id, {
                managedSubdomain: 'late',
            });
            expect(workRepository.update).toHaveBeenNthCalledWith(2, workBefore.id, {
                managedSubdomain: null,
            });
        });

        it.each([
            [
                'a provider refusal (409)',
                () => new DnsRecordConflictError('n.ever.works', 'CNAME', 'x.example.net'),
                ConflictException,
            ],
            [
                'a Cloudflare error (500)',
                () => new Error('cf api down'),
                InternalServerErrorException,
            ],
        ])(
            'keeps the old record when the new write fails after persist: %s',
            async (_label, makeError, expected) => {
                const workBefore = buildWork({ managedSubdomain: 'old-name' });
                workRepository.findById.mockResolvedValue(workBefore);
                provider.ensureRecord.mockRejectedValue(makeError());

                await expect(service.update('work-1', 'new-name')).rejects.toBeInstanceOf(expected);

                expect(provider.removeRecord).not.toHaveBeenCalledWith({
                    host: 'old-name.ever.works',
                });
                expect(zone.has('old-name.ever.works')).toBe(true);
                expect(workRepository.update).toHaveBeenLastCalledWith(workBefore.id, {
                    managedSubdomain: 'old-name',
                });
            },
        );

        it('removes a new record that was created before the write timed out, then rolls back', async () => {
            const workBefore = buildWork({ managedSubdomain: 'old-name' });
            workRepository.findById.mockResolvedValue(workBefore);
            // Cloudflare created the record, but the response never arrived.
            provider.ensureRecord.mockImplementation(async ({ host }: { host: string }) => {
                zone.add(host);
                throw new Error('The operation was aborted due to timeout');
            });

            await expect(service.update('work-1', 'new-name')).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );

            expect(provider.removeRecord).toHaveBeenCalledWith({ host: 'new-name.ever.works' });
            expect(zone.has('new-name.ever.works')).toBe(false);
            // So a retry of the same name is not refused by its own leftover.
            await expect(provider.recordExists('new-name.ever.works')).resolves.toBe(false);
            expect(zone.has('old-name.ever.works')).toBe(true);
            expect(workRepository.update).toHaveBeenLastCalledWith(workBefore.id, {
                managedSubdomain: 'old-name',
            });
        });

        it('does not try to remove the new name after a provider refusal (that record is not ours)', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'old-name' }));
            provider.ensureRecord.mockRejectedValue(
                new DnsRecordConflictError('new-name.ever.works', 'CNAME', 'other.example.net'),
            );

            await expect(service.update('work-1', 'new-name')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(provider.removeRecord).not.toHaveBeenCalled();
        });

        it('keeps the old record when the claim loses a unique-index race (409)', async () => {
            workRepository.findById.mockResolvedValue(buildWork({ managedSubdomain: 'old-name' }));
            workRepository.update.mockRejectedValue({ code: '23505' });

            await expect(service.update('work-1', 'race-loser')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(provider.ensureRecord).not.toHaveBeenCalled();
            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(zone.has('old-name.ever.works')).toBe(true);
        });

        it('never deletes the old record when the old label is a reserved platform name', async () => {
            // A claim persisted before reserved names were enforced on this path.
            zone.add('mcp.ever.works');
            const workBefore = buildWork({ managedSubdomain: 'mcp' });
            workRepository.findById
                .mockResolvedValueOnce(workBefore)
                .mockResolvedValueOnce({ ...workBefore, managedSubdomain: 'new-name' });

            await service.update('work-1', 'new-name');

            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(zone.has('mcp.ever.works')).toBe(true);
            expect(workRepository.update).toHaveBeenCalledWith(workBefore.id, {
                managedSubdomain: 'new-name',
            });
        });

        it('rolls back to null when ensureRecord fails on first-time allocation', async () => {
            const workBefore = buildWork({ managedSubdomain: null });
            workRepository.findById.mockResolvedValue(workBefore);
            provider.ensureRecord.mockRejectedValue(new Error('cf api down'));

            await expect(service.update('work-1', 'first-name')).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );

            expect(workRepository.update).toHaveBeenNthCalledWith(2, workBefore.id, {
                managedSubdomain: null,
            });
        });
    });
    describe('cloudflare provider', () => {
        it('is always editable (no flag)', async () => {
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'cloudflare', managedSubdomain: 'my-site' }),
            );
            process.env.K8S_MANAGED_SUBDOMAIN = 'false';

            expect((await service.getState('work-1')).editable).toBe(true);
        });

        it('renames by persisting the label only: no CNAME, no record removal, no LB needed', async () => {
            delete process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME;
            const workBefore = buildWork({
                deployProvider: 'cloudflare',
                managedSubdomain: 'old-name',
            });
            const workAfter = { ...workBefore, managedSubdomain: 'new-name' };
            workRepository.findById
                .mockResolvedValueOnce(workBefore)
                .mockResolvedValueOnce(workAfter);

            const result = await service.update('work-1', 'New-Name');

            expect(workRepository.update).toHaveBeenCalledWith(workBefore.id, {
                managedSubdomain: 'new-name',
            });
            expect(provider.ensureRecord).not.toHaveBeenCalled();
            expect(provider.removeRecord).not.toHaveBeenCalled();
            expect(result.subdomain).toBe('new-name');
        });

        it('refuses with 409 a hostname that already exists in the zone (the deploy would take it over)', async () => {
            zone.add('existing-host.ever.works');
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'cloudflare', managedSubdomain: 'old-name' }),
            );

            await expect(service.update('work-1', 'existing-host')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('still probes the zone when only the LB target is missing (the probe writes nothing)', async () => {
            dnsService.getProvider.mockReturnValue(null);
            zone.add('existing-host.ever.works');
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'cloudflare', managedSubdomain: 'old-name' }),
            );

            await expect(service.update('work-1', 'existing-host')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(provider.recordExists).toHaveBeenCalledWith('existing-host.ever.works');
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('renames without a zone probe when no zone is configured at all', async () => {
            dnsService.getProvider.mockReturnValue(null);
            dnsService.getZoneProbe.mockReturnValue(null);
            const workBefore = buildWork({ deployProvider: 'cloudflare', managedSubdomain: null });
            workRepository.findById.mockResolvedValue(workBefore);

            await service.update('work-1', 'new-name');

            expect(provider.recordExists).not.toHaveBeenCalled();
            expect(workRepository.update).toHaveBeenCalledWith(workBefore.id, {
                managedSubdomain: 'new-name',
            });
        });

        it('still rejects a label claimed by another work', async () => {
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'cloudflare', managedSubdomain: 'old-name' }),
            );
            workRepository.findByManagedSubdomain.mockResolvedValue({ id: 'someone-else' });

            await expect(service.update('work-1', 'taken')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('maps a unique-violation on persist to 409 Conflict', async () => {
            workRepository.findById.mockResolvedValue(
                buildWork({ deployProvider: 'cloudflare', managedSubdomain: null }),
            );
            workRepository.update.mockRejectedValue(
                Object.assign(new Error('dup'), { code: '23505' }),
            );

            await expect(service.update('work-1', 'racy')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });
    });
});
