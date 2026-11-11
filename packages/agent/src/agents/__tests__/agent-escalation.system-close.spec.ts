import { DataSource, type Repository } from 'typeorm';
import { AGENT_ESCALATION_REASON_CODES } from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { AgentEscalationRepository } from '../../database/repositories/agent-escalation.repository';
import { AgentEscalation } from '../../entities/agent-escalation.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import {
    AgentEscalationService,
    SYSTEM_CLOSABLE_ESCALATION_REASONS,
    SYSTEM_CLOSE_NOTE_RUN_GONE,
    systemCloseNote,
} from '../agent-escalation.service';
import { AgentRunTerminalEscalationListener } from '../agent-run-terminal-escalation.listener';

/**
 * A `queued-too-long` escalation closes itself once its run has ended.
 *
 * The owner's dashboard held thirty "Run has been queued for 143 minutes …
 * Nothing was reaped — the run is still queued" cards, two to three weeks old,
 * for runs that had all since FAILED. The card never closed itself, and
 * closing it by hand needs a signed-in person (which stays true). These specs
 * pin the system close: no user id, a fixed note, the Inbox mirror closed,
 * nothing resumed — and ONLY for `queued-too-long`.
 */
describe('queued-too-long escalations close when their run ends', () => {
    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    describe('which reasons the system may close', () => {
        it('is queued-too-long only — every other reason stays a human decision', () => {
            expect(SYSTEM_CLOSABLE_ESCALATION_REASONS).toEqual(['queued-too-long']);
            const manual = AGENT_ESCALATION_REASON_CODES.filter(
                (code) => !SYSTEM_CLOSABLE_ESCALATION_REASONS.includes(code),
            );
            expect(manual).toEqual(
                expect.arrayContaining([
                    'awaiting-input',
                    'run-parked',
                    'gate-exhausted',
                    'gate-precheck-red',
                    'judge-escalated',
                    'loop-detected',
                    'guardrail-refusal',
                    'budget-stop',
                    'merge-refused',
                    'delivery-failed',
                ]),
            );
        });

        it('writes a fixed note naming the end status and time', () => {
            expect(systemCloseNote('failed', new Date('2026-11-10T21:04:00.000Z'))).toBe(
                'Closed automatically: the run ended (failed) at 2026-11-10T21:04:00.000Z.',
            );
            expect(systemCloseNote(null, null)).toBe(
                'Closed automatically: the run ended (unknown).',
            );
        });
    });

    describe('AgentEscalationService (system path)', () => {
        let repository: {
            findOpenQueuedTooLongForRun: jest.Mock;
            findOpenQueuedTooLongWithEndedRun: jest.Mock;
            resolveBySystem: jest.Mock;
        };
        let inbox: { escalationResolved: jest.Mock };

        function makeSvc(): AgentEscalationService {
            const svc = new AgentEscalationService(repository as never, undefined, inbox as never);
            for (const level of ['warn', 'log'] as const) {
                jest.spyOn(
                    (svc as never as { logger: Record<string, () => void> }).logger,
                    level,
                ).mockImplementation(() => undefined);
            }
            return svc;
        }

        beforeEach(() => {
            repository = {
                findOpenQueuedTooLongForRun: jest
                    .fn()
                    .mockResolvedValue({ id: 'e1', reasonCode: 'queued-too-long' }),
                findOpenQueuedTooLongWithEndedRun: jest.fn().mockResolvedValue([]),
                resolveBySystem: jest.fn().mockResolvedValue(true),
            };
            inbox = { escalationResolved: jest.fn().mockResolvedValue(undefined) };
        });

        afterEach(() => jest.restoreAllMocks());

        it('closes the open card of an ended run with no user id and closes its Inbox mirror', async () => {
            const finishedAt = new Date('2026-11-10T21:04:00.000Z');

            await expect(
                makeSvc().closeQueuedTooLongForEndedRun({
                    runId: 'r1',
                    status: 'failed',
                    finishedAt,
                }),
            ).resolves.toBe(true);

            const note =
                'Closed automatically: the run ended (failed) at 2026-11-10T21:04:00.000Z.';
            expect(repository.resolveBySystem).toHaveBeenCalledWith(
                'e1',
                ['queued-too-long'],
                note,
            );
            // `system`: the mirror closes, nothing is resumed or steered, no person is named.
            expect(inbox.escalationResolved).toHaveBeenCalledWith({
                escalationId: 'e1',
                resolvedByUserId: null,
                note,
                resolvedBy: 'system',
            });
        });

        it('does nothing when the run had no open card', async () => {
            repository.findOpenQueuedTooLongForRun.mockResolvedValue(null);

            await expect(
                makeSvc().closeQueuedTooLongForEndedRun({
                    runId: 'r1',
                    status: 'completed',
                    finishedAt: null,
                }),
            ).resolves.toBe(false);
            expect(repository.resolveBySystem).not.toHaveBeenCalled();
            expect(inbox.escalationResolved).not.toHaveBeenCalled();
        });

        it('leaves the Inbox alone when a person closed the card first (CAS lost)', async () => {
            repository.resolveBySystem.mockResolvedValue(false);

            await expect(
                makeSvc().closeQueuedTooLongForEndedRun({
                    runId: 'r1',
                    status: 'failed',
                    finishedAt: null,
                }),
            ).resolves.toBe(false);
            expect(inbox.escalationResolved).not.toHaveBeenCalled();
        });

        it('never throws, even when the store is down', async () => {
            repository.findOpenQueuedTooLongForRun.mockRejectedValue(new Error('db down'));

            await expect(
                makeSvc().closeQueuedTooLongForEndedRun({
                    runId: 'r1',
                    status: 'failed',
                    finishedAt: null,
                }),
            ).resolves.toBe(false);
        });

        it('the backstop sweep closes every stale card it finds, including one whose run is gone', async () => {
            repository.findOpenQueuedTooLongWithEndedRun.mockResolvedValue([
                {
                    escalation: { id: 'e1' },
                    runStatus: 'failed',
                    runFinishedAt: new Date('2026-10-20T08:00:00.000Z'),
                },
                { escalation: { id: 'e2' }, runStatus: null, runFinishedAt: null },
            ]);

            await expect(makeSvc().closeEndedQueuedTooLong(50)).resolves.toBe(2);

            expect(repository.findOpenQueuedTooLongWithEndedRun).toHaveBeenCalledWith(50);
            expect(repository.resolveBySystem).toHaveBeenCalledWith(
                'e1',
                ['queued-too-long'],
                'Closed automatically: the run ended (failed) at 2026-10-20T08:00:00.000Z.',
            );
            expect(repository.resolveBySystem).toHaveBeenCalledWith(
                'e2',
                ['queued-too-long'],
                SYSTEM_CLOSE_NOTE_RUN_GONE,
            );
            expect(inbox.escalationResolved).toHaveBeenCalledTimes(2);
        });

        it('a manual resolve still records the person (the human door is unchanged)', async () => {
            const human = { ...repository, resolve: jest.fn().mockResolvedValue(true) };
            const svc = new AgentEscalationService(human as never, undefined, inbox as never);

            await svc.resolve('e1', USER, 'raised the limit');

            expect(human.resolve).toHaveBeenCalledWith('e1', USER, 'raised the limit');
            expect(inbox.escalationResolved).toHaveBeenCalledWith({
                escalationId: 'e1',
                resolvedByUserId: USER,
                note: 'raised the limit',
            });
        });
    });

    describe('AgentRunTerminalEscalationListener', () => {
        it('closes the card only for a run the sweeper flagged queued-too-long', async () => {
            const escalations = {
                closeQueuedTooLongForEndedRun: jest.fn().mockResolvedValue(true),
            };
            const listener = new AgentRunTerminalEscalationListener(escalations as never);
            const finishedAt = new Date('2026-11-10T21:04:00.000Z');

            await listener.handleRunTerminal({
                runId: 'r1',
                agentId: AGENT,
                status: 'failed',
                finishedAt,
                attentionReason: 'queued-too-long',
                queuedReason: null,
            });
            await listener.handleRunTerminal({
                runId: 'r2',
                agentId: AGENT,
                status: 'completed',
                finishedAt,
                attentionReason: null,
                queuedReason: null,
            });
            await listener.handleRunTerminal({
                runId: 'r3',
                agentId: AGENT,
                status: 'completed',
                finishedAt,
                attentionReason: 'stale-parked',
                queuedReason: null,
            });

            // Ended while still parked for capacity: "raise the limit?" stands.
            await listener.handleRunTerminal({
                runId: 'r4',
                agentId: AGENT,
                status: 'failed',
                finishedAt,
                attentionReason: 'queued-too-long',
                queuedReason: 'concurrency-limit',
            });

            expect(escalations.closeQueuedTooLongForEndedRun).toHaveBeenCalledTimes(1);
            expect(escalations.closeQueuedTooLongForEndedRun).toHaveBeenCalledWith({
                runId: 'r1',
                status: 'failed',
                finishedAt,
            });
        });

        it('is inert without the escalation service', async () => {
            await expect(
                new AgentRunTerminalEscalationListener().handleRunTerminal({
                    runId: 'r1',
                    agentId: AGENT,
                    status: 'failed',
                    finishedAt: null,
                    attentionReason: 'queued-too-long',
                    queuedReason: null,
                }),
            ).resolves.toBeUndefined();
        });
    });

    describe('AgentEscalationRepository (real database)', () => {
        let dataSource: DataSource;
        let escalations: Repository<AgentEscalation>;
        let runRows: Repository<AgentRun>;
        let repository: AgentEscalationRepository;

        beforeAll(async () => {
            dataSource = new DataSource({
                type: 'better-sqlite3',
                database: ':memory:',
                entities: ENTITIES,
                synchronize: true,
            });
            await dataSource.initialize();
            await dataSource.query('PRAGMA foreign_keys = OFF');
            escalations = dataSource.getRepository(AgentEscalation);
            runRows = dataSource.getRepository(AgentRun);
            repository = new AgentEscalationRepository(escalations);
        });

        afterAll(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        beforeEach(async () => {
            await escalations.clear();
            await runRows.clear();
        });

        async function run(
            status: AgentRun['status'],
            queuedReason: string | null = null,
        ): Promise<AgentRun> {
            return runRows.save(
                runRows.create({
                    agentId: AGENT,
                    userId: USER,
                    triggerKind: 'task',
                    status,
                    queuedReason,
                    finishedAt:
                        status === 'queued' || status === 'running'
                            ? null
                            : new Date('2026-10-20T08:00:00.000Z'),
                }),
            );
        }

        async function card(
            reasonCode: AgentEscalation['reasonCode'],
            runId: string,
        ): Promise<AgentEscalation> {
            const row = await repository.record({
                userId: USER,
                reasonCode,
                runId,
                agentId: AGENT,
                summary: 'Run has been queued for 143 minutes without starting.',
                decisionNeeded: 'Nothing was reaped — the run is still queued.',
            });
            return row!;
        }

        it('finds the open card of a run by its idempotency key', async () => {
            const failed = await run('failed');
            const open = await card('queued-too-long', failed.id);

            expect((await repository.findOpenQueuedTooLongForRun(failed.id))?.id).toBe(open.id);
            expect(await repository.findOpenQueuedTooLongForRun(USER)).toBeNull();
        });

        it('lists the stale cards: run ended or gone — never a still-queued or capacity-starved run, never another reason', async () => {
            const failed = await run('failed');
            const stillQueued = await run('queued');
            const parkedRun = await run('completed');
            // Reaped while still parked for capacity: its "raise the limit?" stands.
            const starved = await run('failed', 'concurrency-limit');
            const gone = '99999999-9999-4999-8999-999999999999';
            const staleCard = await card('queued-too-long', failed.id);
            await card('queued-too-long', stillQueued.id);
            await card('run-parked', parkedRun.id);
            await card('queued-too-long', starved.id);
            const goneCard = await card('queued-too-long', gone);

            const found = await repository.findOpenQueuedTooLongWithEndedRun(50);

            expect(found.map((row) => row.escalation.id).sort()).toEqual(
                [staleCard.id, goneCard.id].sort(),
            );
            const stale = found.find((row) => row.escalation.id === staleCard.id)!;
            expect(stale.runStatus).toBe('failed');
            expect(stale.runFinishedAt?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
            expect(found.find((row) => row.escalation.id === goneCard.id)!.runStatus).toBeNull();
        });

        it('resolves as the system with no user id, once, and only for the reasons named', async () => {
            const failed = await run('failed');
            const stale = await card('queued-too-long', failed.id);
            const parked = await card('run-parked', (await run('completed')).id);

            await expect(
                repository.resolveBySystem(stale.id, ['queued-too-long'], 'Closed automatically'),
            ).resolves.toBe(true);
            // Idempotent: a closed card does not close twice.
            await expect(
                repository.resolveBySystem(stale.id, ['queued-too-long'], 'again'),
            ).resolves.toBe(false);
            // A reason that must stay manual cannot be closed through this door.
            await expect(
                repository.resolveBySystem(parked.id, ['queued-too-long'], 'nope'),
            ).resolves.toBe(false);

            const closed = await escalations.findOneByOrFail({ id: stale.id });
            expect(closed.status).toBe('resolved');
            expect(closed.resolvedByUserId).toBeNull();
            expect(closed.resolutionNote).toBe('Closed automatically');
            expect(closed.resolvedAt).toBeInstanceOf(Date);
            expect((await escalations.findOneByOrFail({ id: parked.id })).status).toBe('open');
            expect(await repository.findOpenQueuedTooLongWithEndedRun(50)).toEqual([]);
        });
    });
});
