import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ENTITIES } from '../../database/database.config';
import { AgentEscalationRepository } from '../../database/repositories/agent-escalation.repository';
import {
    ATTENTION_REASON_QUEUED_TOO_LONG,
    AgentRunRepository,
} from '../../database/repositories/agent-run.repository';
import { AgentEscalation } from '../../entities/agent-escalation.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AgentEscalationService } from '../agent-escalation.service';
import { AgentRunTerminalEscalationListener } from '../agent-run-terminal-escalation.listener';

/**
 * The self-closing `queued-too-long` escalation, wired through a REAL Nest
 * container exactly as the API wires it: `EventEmitterModule.forRoot()`
 * (global, as in `apps/api/src/api.module.ts`), the repository injected with
 * its own decorators, the listener discovered by `@OnEvent`.
 *
 * The unit specs construct the repository with an emitter by hand, so they
 * pass even if the repository's `EventEmitter2` injection were missing or
 * unresolvable in Nest (the event would silently never fire in production and
 * the card would never close). This one fails then: the run ends, and the
 * card must be resolved by the time the terminal write resolves.
 */
describe('queued-too-long auto-close — through Nest DI', () => {
    let moduleRef: TestingModule;
    let runRows: Repository<AgentRun>;
    let escalationRows: Repository<AgentEscalation>;

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                EventEmitterModule.forRoot(),
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                TypeOrmModule.forFeature([AgentRun, AgentEscalation]),
            ],
            providers: [
                AgentRunRepository,
                AgentEscalationRepository,
                AgentEscalationService,
                AgentRunTerminalEscalationListener,
            ],
        }).compile();
        // `@OnEvent` listeners are registered on application bootstrap.
        await moduleRef.init();
        runRows = moduleRef.get(getRepositoryToken(AgentRun));
        escalationRows = moduleRef.get(getRepositoryToken(AgentEscalation));
    });

    afterAll(async () => {
        await moduleRef?.close();
    });

    async function flaggedRun(queuedReason: string | null): Promise<AgentRun> {
        return runRows.save(
            runRows.create({
                agentId: AGENT,
                userId: USER,
                triggerKind: 'task',
                status: 'queued',
                attentionReason: ATTENTION_REASON_QUEUED_TOO_LONG,
                queuedReason,
            }),
        );
    }

    async function card(runId: string): Promise<AgentEscalation> {
        const row = await moduleRef.get(AgentEscalationRepository).record({
            userId: USER,
            reasonCode: 'queued-too-long',
            runId,
            agentId: AGENT,
            summary: 'Run has been queued for 143 minutes without starting.',
            decisionNeeded: 'Nothing was reaped — the run is still queued.',
        });
        return row!;
    }

    it('closes the card, as the system, when the run ends', async () => {
        const run = await flaggedRun(null);
        const open = await card(run.id);

        await moduleRef.get(AgentRunRepository).markStuckFailed([run.id], 'stuck-timeout');

        const closed = await escalationRows.findOneByOrFail({ id: open.id });
        expect(closed.status).toBe('resolved');
        expect(closed.resolvedByUserId).toBeNull();
        expect(closed.resolutionNote).toMatch(
            /^Closed automatically: the run ended \(failed\) at \d{4}-\d{2}-\d{2}T/,
        );
    });

    it('leaves a card whose run ended still parked for capacity to a person', async () => {
        const run = await flaggedRun('concurrency-limit');
        const open = await card(run.id);

        await moduleRef.get(AgentRunRepository).markStuckFailed([run.id], 'stuck-timeout');

        expect((await escalationRows.findOneByOrFail({ id: open.id })).status).toBe('open');
    });
});
