import { DataSource, type Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { Agent } from '../../entities/agent.entity';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { AgentRepository } from './agent.repository';

/**
 * The Agents card's "Runs on schedule · next …" — which Agents are driven by
 * an ACTIVE recurring Task, and the soonest next fire, for a whole list page
 * in one batched read (never one per card).
 */
describe('AgentRepository.findRecurringTaskDrivers', () => {
    let dataSource: DataSource;
    let tasks: Repository<Task>;
    let assignees: Repository<TaskAssignee>;
    let repository: AgentRepository;
    let slugSeq = 0;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const BUILDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const REVIEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const IDLE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const NOW = new Date('2026-11-10T22:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        tasks = dataSource.getRepository(Task);
        assignees = dataSource.getRepository(TaskAssignee);
        repository = new AgentRepository(dataSource.getRepository(Agent));
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await assignees.clear();
        await tasks.clear();
    });

    async function recurring(over: Partial<Task> = {}): Promise<Task> {
        slugSeq += 1;
        return tasks.save(
            tasks.create({
                userId: OWNER,
                slug: `T-${slugSeq}`,
                title: `Nightly ${slugSeq}`,
                status: TaskStatus.TODO,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: OWNER,
                isRecurring: true,
                recurrenceCron: '0 3 * * *',
                nextOccurrenceAt: new Date('2026-11-11T03:00:00.000Z'),
                recurrenceOccurredCount: 0,
                tenantId: TENANT,
                organizationId: ORG,
                ...over,
            } as Partial<Task>),
        );
    }

    async function assign(taskId: string, agentId: string): Promise<void> {
        await assignees.save(
            assignees.create({ taskId, assigneeType: 'agent', assigneeId: agentId }),
        );
    }

    const SCOPE = { tenantId: TENANT, organizationId: ORG };

    it('counts the active recurring Tasks per Agent and keeps the soonest next fire', async () => {
        await recurring({
            agentId: BUILDER,
            nextOccurrenceAt: new Date('2026-11-11T05:00:00.000Z'),
        });
        const assigned = await recurring({
            nextOccurrenceAt: new Date('2026-11-11T01:00:00.000Z'),
        });
        await assign(assigned.id, BUILDER);
        await assign(assigned.id, REVIEWER);

        const drivers = await repository.findRecurringTaskDrivers(
            OWNER,
            [BUILDER, REVIEWER, IDLE],
            SCOPE,
            NOW,
        );

        expect(drivers.get(BUILDER)).toEqual({
            activeCount: 2,
            nextRunAt: new Date('2026-11-11T01:00:00.000Z'),
        });
        expect(drivers.get(REVIEWER)?.activeCount).toBe(1);
        // No Task drives it: absent, which the card reads as "Runs when assigned".
        expect(drivers.has(IDLE)).toBe(false);
    });

    it("an agent assignee replaces the Task's own agentId, as the dispatcher resolves it", async () => {
        const task = await recurring({ agentId: BUILDER });
        await assign(task.id, REVIEWER);

        const drivers = await repository.findRecurringTaskDrivers(
            OWNER,
            [BUILDER, REVIEWER],
            SCOPE,
            NOW,
        );

        expect(drivers.has(BUILDER)).toBe(false);
        expect(drivers.get(REVIEWER)?.activeCount).toBe(1);
    });

    it('leaves out paused, ended, exhausted, spawned and non-recurring Tasks', async () => {
        await recurring({ agentId: BUILDER, recurrencePausedAt: new Date('2026-11-01') });
        await recurring({ agentId: BUILDER, recurrenceEndsAt: new Date('2026-11-01') });
        await recurring({
            agentId: BUILDER,
            recurrenceMaxOccurrences: 3,
            recurrenceOccurredCount: 3,
        });
        await recurring({
            agentId: BUILDER,
            isRecurring: false,
            parentRecurringTaskId: '77777777-7777-4777-8777-777777777777',
        });
        await recurring({ agentId: BUILDER, isRecurring: false });
        await recurring({ agentId: BUILDER, nextOccurrenceAt: null });

        const drivers = await repository.findRecurringTaskDrivers(OWNER, [BUILDER], SCOPE, NOW);

        expect(drivers.has(BUILDER)).toBe(false);
    });

    it("counts only the caller's own Tasks in the request scope — never another person's schedule", async () => {
        await recurring({ agentId: BUILDER, userId: OTHER });
        await recurring({ agentId: BUILDER, organizationId: null, tenantId: TENANT });

        const drivers = await repository.findRecurringTaskDrivers(OWNER, [BUILDER], SCOPE, NOW);

        expect(drivers.has(BUILDER)).toBe(false);
    });

    it('answers an empty page without a query', async () => {
        const spy = jest.spyOn(dataSource.manager, 'createQueryBuilder');
        await expect(repository.findRecurringTaskDrivers(OWNER, [], SCOPE, NOW)).resolves.toEqual(
            new Map(),
        );
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
