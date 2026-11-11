import { DataSource } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { Task, TaskStatus } from '@src/entities/task.entity';
import { ENTITIES } from '../_entities-inventory';
import {
    TASK_PULL_REQUEST_SUMMARY_HEAD_CHARS,
    TASK_PULL_REQUESTS_BY_WORK_MAX,
    TaskRepository,
} from './task.repository';

/**
 * `findPullRequestsByWork` — the fleet planner's "work in flight" read —
 * executed against a real (in-memory) database, the better-sqlite3 driver CI
 * and the e2e stack run, rather than a mocked query builder. What a mock
 * cannot show and this pins: the join on `latestRunId` brings each Task's
 * run summary in the SAME query, the owner predicate holds on the Task AND on
 * the joined run, "open" excludes a pull request the provider reported
 * closed or merged, and the page is bounded and newest first.
 */
describe('TaskRepository.findPullRequestsByWork (integration)', () => {
    let dataSource: DataSource;
    let repository: TaskRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const OTHER_WORK = '44444444-4444-4444-8444-444444444444';
    const AGENT = '55555555-5555-4555-8555-555555555555';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        repository = new TaskRepository(dataSource.getRepository(Task));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(Task).clear();
        await dataSource.getRepository(AgentRun).clear();
    });

    let sequence = 0;
    async function seed(
        over: Partial<Task> & { summary?: string | null; runUserId?: string } = {},
    ): Promise<Task> {
        sequence += 1;
        const { summary, runUserId, ...task } = over;
        let latestRunId: string | null = null;
        if (summary !== undefined) {
            const runs = dataSource.getRepository(AgentRun);
            const run = await runs.save(
                runs.create({
                    agentId: AGENT,
                    userId: runUserId ?? task.userId ?? USER,
                    triggerKind: 'task',
                    status: 'completed',
                    summary,
                } as Partial<AgentRun>),
            );
            latestRunId = run.id;
        }
        const tasks = dataSource.getRepository(Task);
        return tasks.save(
            tasks.create({
                userId: USER,
                slug: `T-${sequence}`,
                title: `Task ${sequence}`,
                createdByType: 'user',
                createdById: USER,
                status: TaskStatus.IN_REVIEW,
                priority: 'p2',
                workId: WORK,
                branchState: 'pr-open',
                prNumber: sequence,
                prUrl: `https://github.com/acme/site/pull/${task.prNumber ?? sequence}`,
                prState: null,
                latestRunId,
                ...task,
            } as Partial<Task>),
        );
    }

    it('lists the open pull requests of the Work, newest first, each with its run summary', async () => {
        await seed({ prNumber: 3, summary: 'Fixed the salary filter.' });
        await seed({ prNumber: 9, prState: 'open', summary: 'Added the digest email.' });
        await seed({ prNumber: 5, prState: 'draft', summary: null });
        await seed({ prNumber: 7 });

        const rows = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 15,
        });

        expect(rows.map((row) => row.prNumber)).toEqual([9, 7, 5, 3]);
        expect(rows[0]).toEqual({
            taskId: expect.any(String),
            slug: expect.stringMatching(/^T-\d+$/),
            title: expect.stringMatching(/^Task \d+$/),
            prNumber: 9,
            prUrl: 'https://github.com/acme/site/pull/9',
            prState: 'open',
            summary: 'Added the digest email.',
        });
        expect(rows.find((row) => row.prNumber === 7)!.summary).toBeNull();
        expect(rows.find((row) => row.prNumber === 5)!.summary).toBeNull();
        expect(rows.find((row) => row.prNumber === 3)!.summary).toBe('Fixed the salary filter.');
    });

    it('leaves out what is not open: closed or merged at the provider, no pull request, another state', async () => {
        await seed({ prNumber: 1, prState: 'closed' });
        await seed({ prNumber: 2, prState: 'merged' });
        await seed({ prNumber: null, prUrl: null });
        await seed({ prNumber: 4, branchState: 'pushed' });
        await seed({ prNumber: 5, branchState: 'conflict' });
        await seed({ prNumber: 6 });

        const rows = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 15,
        });
        expect(rows.map((row) => row.prNumber)).toEqual([6]);
    });

    it('is owner-scoped on the Task and on the joined run, and scoped to the one Work', async () => {
        await seed({ prNumber: 1, userId: OTHER_USER });
        await seed({ prNumber: 2, workId: OTHER_WORK });
        // The Task is the owner's, but its pointer names another owner's run.
        await seed({ prNumber: 3, summary: 'another owner wrote this', runUserId: OTHER_USER });

        const rows = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 15,
        });
        expect(rows.map((row) => row.prNumber)).toEqual([3]);
        expect(rows[0]!.summary).toBeNull();
    });

    it('leaves out the Task being planned', async () => {
        const own = await seed({ prNumber: 1 });
        await seed({ prNumber: 2 });
        const rows = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 15,
            excludeTaskId: own.id,
        });
        expect(rows.map((row) => row.prNumber)).toEqual([2]);
    });

    it('lists merged pull requests by the provider state or the recorded merge', async () => {
        await seed({ prNumber: 1, prState: 'merged', branchState: 'cleaned', summary: 'One.' });
        await seed({ prNumber: 2, branchState: 'merged', summary: 'Two.' });
        await seed({ prNumber: 3, prState: 'closed', branchState: 'pr-open' });
        await seed({ prNumber: 4 });

        const rows = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'merged',
            limit: 5,
        });
        expect(rows.map((row) => row.prNumber).sort()).toEqual([1, 2]);
        expect(rows.map((row) => row.summary).sort()).toEqual(['One.', 'Two.']);
    });

    it('is bounded: the limit, the hard ceiling, and only the head of each summary', async () => {
        for (let index = 0; index < TASK_PULL_REQUESTS_BY_WORK_MAX + 5; index += 1) {
            await seed({ prNumber: index + 1 });
        }
        await seed({
            prNumber: 1000,
            summary: 'x'.repeat(TASK_PULL_REQUEST_SUMMARY_HEAD_CHARS * 5),
        });

        const page = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 3,
        });
        expect(page.map((row) => row.prNumber)).toEqual([
            1000,
            TASK_PULL_REQUESTS_BY_WORK_MAX + 5,
            TASK_PULL_REQUESTS_BY_WORK_MAX + 4,
        ]);
        expect(page[0]!.summary).toHaveLength(TASK_PULL_REQUEST_SUMMARY_HEAD_CHARS);

        const all = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 10_000,
        });
        expect(all).toHaveLength(TASK_PULL_REQUESTS_BY_WORK_MAX);

        const atLeastOne = await repository.findPullRequestsByWork({
            workId: WORK,
            userId: USER,
            state: 'open',
            limit: 0,
        });
        expect(atLeastOne).toHaveLength(1);
    });

    it('answers nothing without a Work or an owner, without querying', async () => {
        await seed({ prNumber: 1 });
        await expect(
            repository.findPullRequestsByWork({
                workId: '',
                userId: USER,
                state: 'open',
                limit: 5,
            }),
        ).resolves.toEqual([]);
        await expect(
            repository.findPullRequestsByWork({
                workId: WORK,
                userId: '',
                state: 'open',
                limit: 5,
            }),
        ).resolves.toEqual([]);
    });
});
