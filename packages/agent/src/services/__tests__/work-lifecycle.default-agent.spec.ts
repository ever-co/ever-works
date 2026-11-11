// `github-slugger` is an ESM-only dependency pulled in transitively via
// `MarkdownGeneratorService -> readme-builder`. ts-jest cannot parse its
// `import` syntax, so stub it out — this spec never touches slug building.
jest.mock('github-slugger', () => ({
    __esModule: true,
    default: class {
        slug(s: string) {
            return s;
        }
    },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, type Provider } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { OrganizationRepository } from '@src/database/repositories/organization.repository';
import { AgentRepository } from '@src/database/repositories/agent.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import { WorkOwnershipService } from '../work-ownership.service';
import { DeployFacadeService } from '@src/facades/deploy.facade';
import { GitFacadeService } from '@src/facades/git.facade';
import { TemplateCatalogService } from '@src/template-catalog/template-catalog.service';
import { WorkWebsiteRepositoryStateService } from '../work-website-repository-state.service';
import {
    EverWorksDeployQuotaService,
    EverWorksGitProvider,
    EverWorksDnsService,
} from '@src/ever-works-providers';
import { ZeroFrictionFunnelService } from '../zero-friction-funnel.service';
import { ownershipScopeMatches, type OwnershipScope } from '@src/database/ownership-scope';
import { AgentStatus, type Agent } from '@src/entities/agent.entity';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

/**
 * `PATCH /api/works/:id { defaultAgentId }` — the Work's default Agent.
 *
 * Stored only for an Agent the caller owns, not archived, inside the Work's tenant/organization
 * scope; every other id is the same 404 (an Agent of another organization and one that never
 * existed look alike) and never reaches the write. `null` clears it without a lookup.
 */

const WORK_ID = '00000000-0000-4000-8000-000000000001';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c2';
const SHARED_AGENT = '00000000-0000-4000-8000-0000000000d1';
const FOREIGN_AGENT = '00000000-0000-4000-8000-0000000000d2';
const ARCHIVED_AGENT = '00000000-0000-4000-8000-0000000000d3';
const SOMEONE_ELSES_AGENT = '00000000-0000-4000-8000-0000000000d4';
const MISSING_AGENT = '00000000-0000-4000-8000-0000000000d5';
const PERSONAL_AGENT = '00000000-0000-4000-8000-0000000000d6';
const EDITORS_AGENT = '00000000-0000-4000-8000-0000000000d7';

const AGENTS: Agent[] = [
    {
        id: SHARED_AGENT,
        userId: 'user-1',
        status: AgentStatus.ACTIVE,
        tenantId: TENANT,
        organizationId: ORG,
    },
    {
        id: FOREIGN_AGENT,
        userId: 'user-1',
        status: AgentStatus.ACTIVE,
        tenantId: TENANT,
        organizationId: OTHER_ORG,
    },
    {
        id: ARCHIVED_AGENT,
        userId: 'user-1',
        status: AgentStatus.ARCHIVED,
        tenantId: TENANT,
        organizationId: ORG,
    },
    {
        id: SOMEONE_ELSES_AGENT,
        userId: 'user-2',
        status: AgentStatus.ACTIVE,
        tenantId: TENANT,
        organizationId: ORG,
    },
    {
        id: PERSONAL_AGENT,
        userId: 'user-1',
        status: AgentStatus.ACTIVE,
        tenantId: null,
        organizationId: null,
    },
    {
        id: EDITORS_AGENT,
        userId: 'user-3',
        status: AgentStatus.ACTIVE,
        tenantId: TENANT,
        organizationId: ORG,
    },
] as Agent[];

function buildWork(overrides: Partial<Work> = {}): Work {
    return {
        id: WORK_ID,
        name: 'Docs',
        description: 'Product docs',
        owner: 'acme',
        organization: false,
        readmeConfig: null,
        userId: 'user-1',
        tenantId: TENANT,
        organizationId: ORG,
        websiteTemplateId: null,
        deployProvider: 'ever-works',
        defaultAgentId: null,
        getRepoOwner: () => 'acme',
        ...overrides,
    } as unknown as Work;
}

describe('WorkLifecycleService — the Work default Agent', () => {
    let workRepository: { update: jest.Mock };
    let agentRepository: { findByIdAndUser: jest.Mock };
    let work: Work;

    const user = { id: 'user-1', username: 'user-1' } as unknown as User;

    const compile = async (agents: unknown): Promise<WorkLifecycleService> => {
        const providers: Provider[] = [
            WorkLifecycleService,
            { provide: WorkRepository, useValue: workRepository },
            { provide: UserRepository, useValue: {} },
            { provide: OrganizationRepository, useValue: { findById: jest.fn() } },
            { provide: DataGeneratorService, useValue: {} },
            { provide: MarkdownGeneratorService, useValue: {} },
            { provide: WebsiteGeneratorService, useValue: {} },
            { provide: WebsiteUpdateService, useValue: {} },
            {
                provide: WorkOwnershipService,
                useValue: {
                    ensureCanEdit: jest.fn().mockResolvedValue({ work, role: 'owner' }),
                },
            },
            { provide: DeployFacadeService, useValue: { getAvailableProviders: () => [] } },
            { provide: GitFacadeService, useValue: {} },
            { provide: TemplateCatalogService, useValue: {} },
            { provide: WorkWebsiteRepositoryStateService, useValue: {} },
            { provide: EverWorksDeployQuotaService, useValue: {} },
            { provide: EverWorksGitProvider, useValue: {} },
            { provide: EverWorksDnsService, useValue: {} },
            { provide: ZeroFrictionFunnelService, useValue: {} },
            { provide: EventEmitter2, useValue: { emit: jest.fn(), emitAsync: jest.fn() } },
        ];
        if (agents) providers.push({ provide: AgentRepository, useValue: agents });
        const module: TestingModule = await Test.createTestingModule({ providers }).compile();
        return module.get(WorkLifecycleService);
    };

    beforeEach(() => {
        work = buildWork();
        workRepository = {
            update: jest
                .fn()
                .mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
                    ...work,
                    ...data,
                    getRepoOwner: () => 'acme',
                })),
        };
        // Owner- and scope-bound, exactly like `AgentRepository.findByIdAndUser`.
        agentRepository = {
            findByIdAndUser: jest.fn(async (id: string, userId: string, scope?: OwnershipScope) => {
                const row = AGENTS.find((agent) => agent.id === id && agent.userId === userId);
                return row && ownershipScopeMatches(row, scope) ? row : null;
            }),
        };
    });

    it("stores the caller's own Agent from the Work's organization, read within the Work's scope", async () => {
        const service = await compile(agentRepository);
        const result = await service.updateWork(WORK_ID, { defaultAgentId: SHARED_AGENT }, user);

        expect(result.status).toBe('success');
        expect(agentRepository.findByIdAndUser).toHaveBeenCalledWith(SHARED_AGENT, 'user-1', {
            tenantId: TENANT,
            organizationId: ORG,
        });
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({
            defaultAgentId: SHARED_AGENT,
        });
    });

    it.each([
        ['an Agent of another organization', FOREIGN_AGENT],
        ['an archived Agent', ARCHIVED_AGENT],
        ["someone else's Agent", SOMEONE_ELSES_AGENT],
        ['an id that does not exist', MISSING_AGENT],
    ])('refuses %s with the same 404, and writes nothing', async (_label, agentId) => {
        const service = await compile(agentRepository);
        const error = await service
            .updateWork(WORK_ID, { defaultAgentId: agentId }, user)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toMatchObject({
            message: 'Agent not found',
        });
        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('refuses a cross-organization Agent even when the Agent read ignores the scope', async () => {
        const leaky = {
            findByIdAndUser: jest.fn(async (id: string) => AGENTS.find((agent) => agent.id === id)),
        };
        const service = await compile(leaky);
        await expect(
            service.updateWork(WORK_ID, { defaultAgentId: FOREIGN_AGENT }, user),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('clears the default with null, without an Agent lookup', async () => {
        work = buildWork({ defaultAgentId: SHARED_AGENT });
        const service = await compile(agentRepository);
        const result = await service.updateWork(WORK_ID, { defaultAgentId: null }, user);

        expect(result.status).toBe('success');
        expect(agentRepository.findByIdAndUser).not.toHaveBeenCalled();
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({ defaultAgentId: null });
    });

    it('leaves the default alone when the field is omitted', async () => {
        const service = await compile(agentRepository);
        await service.updateWork(WORK_ID, { name: 'Renamed' }, user);

        expect(agentRepository.findByIdAndUser).not.toHaveBeenCalled();
        expect(workRepository.update.mock.calls[0][1]).not.toHaveProperty('defaultAgentId');
    });

    it('fails closed without an Agent repository: an id is refused, null still clears', async () => {
        const service = await compile(undefined);
        await expect(
            service.updateWork(WORK_ID, { defaultAgentId: SHARED_AGENT }, user),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(workRepository.update).not.toHaveBeenCalled();

        await expect(
            service.updateWork(WORK_ID, { defaultAgentId: null }, user),
        ).resolves.toMatchObject({ status: 'success' });
    });

    // Review of #3159, finding 2: a shared Work has ONE default, so only its owner sets or
    // clears it — another editor's write would silently re-route the owner's Missions, Run and
    // Goals. A save that leaves the value as it is stays harmless for every editor.
    describe('only the Work owner changes it', () => {
        const editor = { id: 'user-3', username: 'user-3' } as unknown as User;

        it.each([
            ['setting it', EDITORS_AGENT],
            ['clearing it', null],
        ])(
            'refuses an editor %s with 403 workDefaultAgentOwnerOnly, and writes nothing',
            async (_label, value) => {
                work = buildWork({ defaultAgentId: SHARED_AGENT });
                const service = await compile(agentRepository);
                const error = await service
                    .updateWork(WORK_ID, { defaultAgentId: value }, editor)
                    .catch((e: unknown) => e);

                expect(error).toBeInstanceOf(ForbiddenException);
                expect((error as ForbiddenException).getResponse()).toMatchObject({
                    code: 'workDefaultAgentOwnerOnly',
                });
                expect(agentRepository.findByIdAndUser).not.toHaveBeenCalled();
                expect(workRepository.update).not.toHaveBeenCalled();
            },
        );

        it("lets an editor's save through when it echoes the stored value, without touching it", async () => {
            work = buildWork({ defaultAgentId: SHARED_AGENT });
            const service = await compile(agentRepository);
            await expect(
                service.updateWork(
                    WORK_ID,
                    { name: 'Renamed', defaultAgentId: SHARED_AGENT },
                    editor,
                ),
            ).resolves.toMatchObject({ status: 'success' });
            expect(workRepository.update.mock.calls[0][1]).not.toHaveProperty('defaultAgentId');
        });
    });

    // Review of #3159, finding 3: a Work with no tenant/organization recorded admits only the
    // owner's personal Agents — the write no longer accepts an Agent of any organization.
    describe('a Work with no recorded tenant or organization', () => {
        beforeEach(() => {
            work = buildWork({ tenantId: null, organizationId: null });
        });

        it("stores the owner's personal Agent", async () => {
            const service = await compile(agentRepository);
            await service.updateWork(WORK_ID, { defaultAgentId: PERSONAL_AGENT }, user);
            expect(workRepository.update.mock.calls[0][1]).toMatchObject({
                defaultAgentId: PERSONAL_AGENT,
            });
        });

        it('refuses an organization Agent with the same 404 — even through a read that ignores the scope', async () => {
            const leaky = {
                findByIdAndUser: jest.fn(async (id: string) =>
                    AGENTS.find((agent) => agent.id === id),
                ),
            };
            for (const agents of [agentRepository, leaky]) {
                const service = await compile(agents);
                await expect(
                    service.updateWork(WORK_ID, { defaultAgentId: SHARED_AGENT }, user),
                ).rejects.toBeInstanceOf(NotFoundException);
            }
            expect(workRepository.update).not.toHaveBeenCalled();
        });
    });
});
