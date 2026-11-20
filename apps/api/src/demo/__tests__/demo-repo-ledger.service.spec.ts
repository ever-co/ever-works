import { DataSource } from 'typeorm';
import { DemoGithubRepoRepository, ENTITIES } from '@ever-works/agent/database';
import { DemoGithubRepo } from '@ever-works/agent/entities';
import { DemoRepoLedgerService } from '../demo-repo-ledger.service';

/**
 * Platform demo mode — the API's repository ledger (`DEMO_REPO_LEDGER`). It is reached from
 * the API's own creates and, over `remote/call`, from the Trigger workers', so it stores
 * exactly one well-formed row per call and refuses anything else: a malformed row could
 * point the sweeper at a repository nobody created.
 */

const ENTRY = {
    sandboxUserId: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
    owner: 'ever-works-cloud',
    name: 'demo-0a1b2c3d-awesome-ai-coding-tools-website',
    githubId: null,
};

describe('DemoRepoLedgerService', () => {
    let dataSource: DataSource;
    let service: DemoRepoLedgerService;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        service = new DemoRepoLedgerService(
            new DemoGithubRepoRepository(dataSource.getRepository(DemoGithubRepo)),
        );
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(DemoGithubRepo).clear();
    });

    it('stores the row, pending deletion', async () => {
        await service.record({ ...ENTRY, githubId: 812345678 });

        expect(await dataSource.getRepository(DemoGithubRepo).find()).toEqual([
            expect.objectContaining({
                ...ENTRY,
                githubId: 812345678,
                deletedAt: null,
                attempts: 0,
            }),
        ]);
    });

    it('stores a row without a GitHub id', async () => {
        await service.record(ENTRY);

        expect(await dataSource.getRepository(DemoGithubRepo).find()).toEqual([
            expect.objectContaining({ githubId: null }),
        ]);
    });

    it.each([
        ['a missing sandbox', { ...ENTRY, sandboxUserId: '' }],
        ['a non-string owner', { ...ENTRY, owner: 42 }],
        ['an empty owner', { ...ENTRY, owner: '' }],
        ['an empty name', { ...ENTRY, name: '' }],
        ['a fractional id', { ...ENTRY, githubId: 1.5 }],
        ['a string id', { ...ENTRY, githubId: '812345678' }],
        ['no entry at all', undefined],
    ])('refuses %s and stores nothing', async (_label, entry) => {
        await expect(service.record(entry as never)).rejects.toThrow(/demo ledger/);
        expect(await dataSource.getRepository(DemoGithubRepo).count()).toBe(0);
    });
});
