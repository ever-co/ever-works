import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { In, type DataSource, type ObjectLiteral, type Repository } from 'typeorm';
import { withDerivedActor } from '@ever-works/agent/activity-log';
import {
    ActivityActionType,
    ActivityLog,
    ActivityStatus,
    Agent,
    AgentRun,
    AgentRunLog,
    Conversation,
    ConversationMessage,
    ConversationParticipant,
    Goal,
    GoalEvent,
    Mission,
    Task,
    TaskPriority,
    TaskStatus,
    type CreateActivityLogDto,
} from '@ever-works/agent/entities';
import { GOAL_ITERATION_LABEL } from '@ever-works/agent/goals';
import { MISSION_TASK_LABEL } from '@ever-works/agent/missions';
import type { CreateTaskInput, TasksService } from '@ever-works/agent/tasks-domain';

/**
 * Platform demo mode — the RECORDED EXAMPLES of every demo sandbox (design §5.2.3, "Live +
 * recorded examples"). The free AI quota is small, so each sandbox already shows what the
 * platform does: the completed Goal "Publish the launch blog post" worked by an Agent over two
 * iterations (each a done Task with one finished run and its transcript), the Mission "Ship the
 * launch site" with the Tasks its planner filed and one finished run, an Agent chat, and the
 * activity entries all of that leaves behind.
 *
 * The content lives in `demo-recorded.fixture.json` (hand-written today; a capture exported
 * from a real Works-dev run can replace it in the same format). Ids are generated per sandbox,
 * never read from the file; every time is an offset in minutes before the sandbox's creation.
 *
 * The Tasks go through `TasksService` like every other seeded Task (numbering, visibility,
 * history). The rest are plain rows written through their repositories, so nothing runs:
 * - every run is `completed` (terminal), so no dispatcher, sweeper, heartbeat or admission
 *   count ever selects it, and it carries no Trigger.dev run;
 * - the chat messages are stored `sent`, not sent through `ConversationMessageService.send`,
 *   which is what dispatches an Agent reply;
 * - the Goal's loop is stored `done` (the orchestrator only advances `running` loops) and the
 *   Goal is COMPLETED (the evaluator only checks ACTIVE Goals);
 * - nothing is emitted, and no domain event is recorded for these rows.
 */

/** The fixture file, next to this one (shipped by `nest-cli.json` `assets`). */
export const DEMO_RECORDED_FIXTURE_FILE = 'demo-recorded.fixture.json';

/** One line of a run's transcript, as the session timeline shows it (`agent_run_logs`). */
export interface DemoRecordedTranscriptEntry {
    readonly atMinutes: number;
    readonly kind: 'user-message' | 'assistant-message' | 'tool-invocation';
    /** A message's text. */
    readonly text?: string;
    /** A tool call: the tool, and its arguments and result as the timeline previews them. */
    readonly tool?: string;
    readonly args?: string;
    readonly result?: string;
    readonly durationMs?: number;
    readonly isError?: boolean;
}

/** One finished Agent run. `key` links activity entries to it. */
export interface DemoRecordedRun {
    readonly key: string;
    readonly queuedAtMinutes: number;
    readonly startedAtMinutes: number;
    readonly finishedAtMinutes: number;
    readonly totalTokens: number;
    readonly summary: string;
    readonly transcript: readonly DemoRecordedTranscriptEntry[];
}

/** One iteration of the Goal's loop: who it was routed to, why, its brief and its run. */
export interface DemoRecordedIteration {
    readonly agentSlug: string;
    /** The orchestrator's routing reason code and its reasoning line. */
    readonly reasonCode: string;
    readonly routeReasoning: string;
    /** The iteration Task's description (the orchestrator's brief). */
    readonly brief: string;
    /** The Definition-of-Done criterion a person ticked after this iteration, and when. */
    readonly closes: { readonly criterionId: string; readonly atMinutes: number } | null;
    readonly run: DemoRecordedRun;
}

/** A Task the Mission's planner filed. Only a `done` one has a run. */
export interface DemoRecordedPlannedTask {
    readonly title: string;
    readonly description: string;
    readonly agentSlug: string | null;
    readonly status: 'todo' | 'done';
    readonly run: DemoRecordedRun | null;
}

export const DEMO_RECORDED_ACTIVITY_TYPES = [
    'goal_loop_started',
    'goal_iteration_dispatched',
    'agent_run_completed',
    'goal_dod_updated',
    'goal_loop_completed',
    'mission_tick',
] as const;
export type DemoRecordedActivityType = (typeof DEMO_RECORDED_ACTIVITY_TYPES)[number];

/** One activity-log entry. `run` names a run by key; `criterionId` a Goal criterion. */
export interface DemoRecordedActivity {
    readonly atMinutes: number;
    readonly type: DemoRecordedActivityType;
    readonly summary: string;
    readonly run: string | null;
    readonly criterionId: string | null;
}

export interface DemoRecordedMessage {
    readonly atMinutes: number;
    readonly by: 'user' | 'agent';
    readonly body: string;
}

export interface DemoRecordedFixture {
    readonly format: 1;
    readonly source: string;
    /** What answered every run and chat reply: a free model (its id ends with `:free`). */
    readonly model: { readonly provider: string; readonly id: string };
    readonly goal: {
        /** `DEMO_SANDBOX_FIXTURE.goals[].key` of the completed Goal. */
        readonly goalKey: string;
        readonly loopStartedAtMinutes: number;
        readonly iterations: readonly DemoRecordedIteration[];
        readonly completion: { readonly atMinutes: number; readonly message: string };
    };
    readonly mission: {
        /** `DEMO_SANDBOX_FIXTURE.missions[].key`. */
        readonly missionKey: string;
        readonly plannedAtMinutes: number;
        readonly plan: readonly DemoRecordedPlannedTask[];
    };
    readonly conversation: {
        readonly agentSlug: string;
        readonly title: string;
        readonly messages: readonly DemoRecordedMessage[];
    };
    readonly activity: readonly DemoRecordedActivity[];
}

// ── Reading the fixture ─────────────────────────────────────────────

type Json = Record<string, unknown>;

function fail(path: string, problem: string): never {
    throw new Error(`Demo recorded fixture: ${path} ${problem}`);
}

function object(value: unknown, path: string): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(path, 'must be an object');
    }
    return value as Json;
}

function list(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty list');
    return value;
}

function text(value: unknown, path: string, max = 20_000): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail(path, 'must be a non-empty string');
    }
    if (value.length > max) fail(path, `must be at most ${max} characters`);
    return value;
}

function optionalText(value: unknown, path: string, max?: number): string | null {
    return value === undefined || value === null ? null : text(value, path, max);
}

/** Minutes before the sandbox's creation: the recorded past is never "now" or later. */
function offset(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value >= 0) {
        fail(path, 'must be a negative number of minutes');
    }
    return value;
}

function wholeNumber(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        fail(path, 'must be a whole number, zero or more');
    }
    return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
    if (!options.includes(value as T)) fail(path, `must be one of ${options.join(', ')}`);
    return value as T;
}

function readTranscriptEntry(raw: unknown, path: string): DemoRecordedTranscriptEntry {
    const entry = object(raw, path);
    const atMinutes = offset(entry.atMinutes, `${path}.atMinutes`);
    const kind = oneOf(
        entry.kind,
        ['user-message', 'assistant-message', 'tool-invocation'] as const,
        `${path}.kind`,
    );
    if (kind !== 'tool-invocation') {
        return { atMinutes, kind, text: text(entry.text, `${path}.text`) };
    }
    return {
        atMinutes,
        kind,
        tool: text(entry.tool, `${path}.tool`, 80),
        args: text(entry.args, `${path}.args`),
        result: text(entry.result, `${path}.result`),
        durationMs: wholeNumber(entry.durationMs, `${path}.durationMs`),
        isError: entry.isError === true,
    };
}

function readRun(raw: unknown, path: string): DemoRecordedRun {
    const run = object(raw, path);
    const queuedAtMinutes = offset(run.queuedAtMinutes, `${path}.queuedAtMinutes`);
    const startedAtMinutes = offset(run.startedAtMinutes, `${path}.startedAtMinutes`);
    const finishedAtMinutes = offset(run.finishedAtMinutes, `${path}.finishedAtMinutes`);
    if (!(queuedAtMinutes <= startedAtMinutes && startedAtMinutes < finishedAtMinutes)) {
        fail(path, 'must be queued, then started, then finished');
    }
    const transcript = list(run.transcript, `${path}.transcript`).map((entry, index) =>
        readTranscriptEntry(entry, `${path}.transcript[${index}]`),
    );
    for (const [index, entry] of transcript.entries()) {
        const previous = transcript[index - 1];
        if (entry.atMinutes < startedAtMinutes || entry.atMinutes > finishedAtMinutes) {
            fail(`${path}.transcript[${index}]`, 'must fall between the start and the finish');
        }
        if (previous && entry.atMinutes < previous.atMinutes) {
            fail(`${path}.transcript[${index}]`, 'must not come before the entry above it');
        }
    }
    return {
        key: text(run.key, `${path}.key`, 64),
        queuedAtMinutes,
        startedAtMinutes,
        finishedAtMinutes,
        totalTokens: wholeNumber(run.totalTokens, `${path}.totalTokens`),
        summary: text(run.summary, `${path}.summary`),
        transcript,
    };
}

function readIteration(raw: unknown, path: string): DemoRecordedIteration {
    const iteration = object(raw, path);
    const closes =
        iteration.closes === undefined || iteration.closes === null
            ? null
            : object(iteration.closes, `${path}.closes`);
    return {
        agentSlug: text(iteration.agentSlug, `${path}.agentSlug`),
        reasonCode: text(iteration.reasonCode, `${path}.reasonCode`, 64),
        routeReasoning: text(iteration.routeReasoning, `${path}.routeReasoning`),
        brief: text(iteration.brief, `${path}.brief`),
        closes: closes
            ? {
                  criterionId: text(closes.criterionId, `${path}.closes.criterionId`),
                  atMinutes: offset(closes.atMinutes, `${path}.closes.atMinutes`),
              }
            : null,
        run: readRun(iteration.run, `${path}.run`),
    };
}

function readPlannedTask(raw: unknown, path: string): DemoRecordedPlannedTask {
    const task = object(raw, path);
    const status = oneOf(task.status, ['todo', 'done'] as const, `${path}.status`);
    const run =
        task.run === undefined || task.run === null ? null : readRun(task.run, `${path}.run`);
    const agentSlug = optionalText(task.agentSlug, `${path}.agentSlug`);
    // A finished run is a done Task's, and a run belongs to the Task's Agent.
    if ((status === 'done') !== (run !== null)) fail(path, 'has a run exactly when it is done');
    if (run && !agentSlug) fail(path, 'has a run but no agentSlug');
    return {
        title: text(task.title, `${path}.title`, 120),
        description: text(task.description, `${path}.description`, 4000),
        agentSlug,
        status,
        run,
    };
}

function readMessage(raw: unknown, path: string): DemoRecordedMessage {
    const message = object(raw, path);
    return {
        atMinutes: offset(message.atMinutes, `${path}.atMinutes`),
        by: oneOf(message.by, ['user', 'agent'] as const, `${path}.by`),
        body: text(message.body, `${path}.body`),
    };
}

function readActivity(raw: unknown, path: string): DemoRecordedActivity {
    const entry = object(raw, path);
    return {
        atMinutes: offset(entry.atMinutes, `${path}.atMinutes`),
        type: oneOf(entry.type, DEMO_RECORDED_ACTIVITY_TYPES, `${path}.type`),
        summary: text(entry.summary, `${path}.summary`, 500),
        run: optionalText(entry.run, `${path}.run`),
        criterionId: optionalText(entry.criterionId, `${path}.criterionId`),
    };
}

/**
 * Check a parsed fixture and return it typed. Throws, naming the offending path, on anything a
 * sandbox could not be seeded from: a model that is not free, a time that is not in the past,
 * a run whose times are out of order, an activity entry naming a run that does not exist.
 */
export function parseDemoRecordedFixture(raw: unknown): DemoRecordedFixture {
    const root = object(raw, '(root)');
    if (root.format !== 1) fail('format', 'must be 1');
    const model = object(root.model, 'model');
    const modelId = text(model.id, 'model.id', 100);
    // Ruling: a model id is free iff it ends with `:free`.
    if (!modelId.endsWith(':free')) fail('model.id', 'must name a free model (ending in :free)');

    const goal = object(root.goal, 'goal');
    const completion = object(goal.completion, 'goal.completion');
    const mission = object(root.mission, 'mission');
    const conversation = object(root.conversation, 'conversation');
    const fixture: DemoRecordedFixture = {
        format: 1,
        source: text(root.source, 'source'),
        model: { provider: text(model.provider, 'model.provider', 100), id: modelId },
        goal: {
            goalKey: text(goal.goalKey, 'goal.goalKey'),
            loopStartedAtMinutes: offset(goal.loopStartedAtMinutes, 'goal.loopStartedAtMinutes'),
            iterations: list(goal.iterations, 'goal.iterations').map((entry, index) =>
                readIteration(entry, `goal.iterations[${index}]`),
            ),
            completion: {
                atMinutes: offset(completion.atMinutes, 'goal.completion.atMinutes'),
                message: text(completion.message, 'goal.completion.message'),
            },
        },
        mission: {
            missionKey: text(mission.missionKey, 'mission.missionKey'),
            plannedAtMinutes: offset(mission.plannedAtMinutes, 'mission.plannedAtMinutes'),
            plan: list(mission.plan, 'mission.plan').map((entry, index) =>
                readPlannedTask(entry, `mission.plan[${index}]`),
            ),
        },
        conversation: {
            agentSlug: text(conversation.agentSlug, 'conversation.agentSlug'),
            title: text(conversation.title, 'conversation.title', 200),
            messages: list(conversation.messages, 'conversation.messages').map((entry, index) =>
                readMessage(entry, `conversation.messages[${index}]`),
            ),
        },
        activity: list(root.activity, 'activity').map((entry, index) =>
            readActivity(entry, `activity[${index}]`),
        ),
    };

    const iterationRuns = new Set(fixture.goal.iterations.map((iteration) => iteration.run.key));
    const runKeys = [
        ...iterationRuns,
        ...fixture.mission.plan.flatMap((task) => (task.run ? [task.run.key] : [])),
    ];
    if (new Set(runKeys).size !== runKeys.length) fail('run keys', 'must be unique');

    const messages = fixture.conversation.messages;
    if (messages[0].by !== 'user') fail('conversation.messages[0]', 'must be the visitor’s');
    for (const [index, message] of messages.entries()) {
        if (index > 0 && message.atMinutes < messages[index - 1].atMinutes) {
            fail(`conversation.messages[${index}]`, 'must not come before the message above it');
        }
    }

    for (const [index, entry] of fixture.activity.entries()) {
        const path = `activity[${index}]`;
        const needsRun =
            entry.type === 'goal_iteration_dispatched' || entry.type === 'agent_run_completed';
        if (needsRun !== (entry.run !== null)) fail(path, `names a run exactly for ${entry.type}`);
        if (entry.run && !runKeys.includes(entry.run)) fail(`${path}.run`, 'names no run');
        if (entry.type === 'goal_iteration_dispatched' && !iterationRuns.has(entry.run!)) {
            fail(`${path}.run`, 'must name a Goal iteration’s run');
        }
        if ((entry.type === 'goal_dod_updated') !== (entry.criterionId !== null)) {
            fail(path, 'names a criterion exactly for goal_dod_updated');
        }
    }
    return fixture;
}

let loaded: DemoRecordedFixture | undefined;

/** The recorded examples, read and checked once per process. */
export function loadDemoRecordedFixture(): DemoRecordedFixture {
    loaded ??= parseDemoRecordedFixture(
        JSON.parse(readFileSync(join(__dirname, DEMO_RECORDED_FIXTURE_FILE), 'utf8')),
    );
    return loaded;
}

// ── Writing one sandbox's recorded rows ─────────────────────────────

export interface DemoRecordedSeedDeps {
    readonly dataSource: DataSource;
    readonly tasks: TasksService;
}

export interface DemoRecordedSeedInput {
    readonly ownerId: string;
    /** The sandbox's Tenant + Organization: every row is stamped with them. */
    readonly scope: { readonly tenantId: string; readonly organizationId: string };
    /** When the sandbox was created: every recorded time is an offset before it. */
    readonly createdAt: Date;
    readonly projectWorkId: string;
    /** Seeded ids by `DEMO_SANDBOX_FIXTURE` key / starter-kit template slug. */
    readonly goalIds: ReadonlyMap<string, string>;
    readonly missionIds: ReadonlyMap<string, string>;
    readonly agentIds: ReadonlyMap<string, string>;
}

/** A recorded run as written, for the Goal events and activity entries that name it. */
interface WrittenRun {
    readonly id: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly goalId: string | null;
    readonly missionId: string | null;
    readonly iteration: number | null;
    readonly reasonCode: string | null;
}

const MINUTE_MS = 60_000;

/** `modelRouting.runTimeoutSeconds`: the platform default (contracts `MODEL_ROUTING_LIMITS`). */
const RUN_TIMEOUT_SECONDS = 900;

/** Write the recorded examples of one sandbox. Answers the recorded Goal's id. */
export async function seedRecordedExamples(
    deps: DemoRecordedSeedDeps,
    input: DemoRecordedSeedInput,
): Promise<{ goalId: string }> {
    return new RecordedExamplesWriter(deps, input, loadDemoRecordedFixture()).write();
}

class RecordedExamplesWriter {
    private readonly runs = new Map<string, WrittenRun>();
    private agentNames = new Map<string, string>();

    constructor(
        private readonly deps: DemoRecordedSeedDeps,
        private readonly input: DemoRecordedSeedInput,
        private readonly fixture: DemoRecordedFixture,
    ) {}

    async write(): Promise<{ goalId: string }> {
        const goal = await this.repo(Goal).findOneByOrFail({
            id: lookup(this.input.goalIds, this.fixture.goal.goalKey, 'goal'),
        });
        const mission = await this.repo(Mission).findOneByOrFail({
            id: lookup(this.input.missionIds, this.fixture.mission.missionKey, 'mission'),
        });
        const agents = await this.repo(Agent).findBy({ id: In([...this.input.agentIds.values()]) });
        this.agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

        await this.writeGoalLoop(goal);
        await this.writeMissionPlan(mission);
        await this.writeConversation();
        await this.writeActivity(goal, mission);
        return { goalId: goal.id };
    }

    /** Two iteration Tasks with their runs, the orchestrator's log, and the finished loop. */
    private async writeGoalLoop(goal: Goal): Promise<void> {
        const { iterations, completion, loopStartedAtMinutes } = this.fixture.goal;
        const criteria = goal.dodCriteria ?? [];
        const waived = criteria.filter((entry) => entry.status === 'waived').length;
        const ticked = new Set<string>();
        const events: Array<Partial<GoalEvent>> = [];
        for (const [index, iteration] of iterations.entries()) {
            const number = index + 1;
            const agentId = this.agent(iteration.agentSlug);
            // Exactly what `GoalOrchestratorService.applyDispatch` files for an iteration.
            const task = await this.fileTask(
                {
                    title: `[Goal] ${goal.title} — iteration ${number}`,
                    description: iteration.brief,
                    priority: TaskPriority.P2,
                    labels: [GOAL_ITERATION_LABEL],
                    goalId: goal.id,
                    workId: goal.workId ?? this.input.projectWorkId,
                    agentId,
                    derivedFromPrivate: goal.visibility === 'private',
                    derivedFrom: { aggregate: 'goal', id: goal.id },
                },
                TaskStatus.DONE,
            );
            const run = await this.writeRun(iteration.run, task, agentId, {
                goalId: goal.id,
                iteration: number,
                reasonCode: iteration.reasonCode,
            });
            await this.backdateTask(task.id, iteration.run.queuedAtMinutes, iteration.run, run);

            const dispatchedAt = this.at(iteration.run.queuedAtMinutes);
            events.push(
                {
                    kind: 'route',
                    message: iteration.routeReasoning,
                    agentId,
                    iteration: number,
                    metadata: { reasonCode: iteration.reasonCode },
                    createdAt: dispatchedAt,
                },
                {
                    kind: 'dispatch',
                    message: `Dispatched iteration ${number} — session task ${task.slug} created for agent ${agentId}.`,
                    agentId,
                    taskId: task.id,
                    iteration: number,
                    metadata: {
                        runId: run.id,
                        dispatched: true,
                        parked: false,
                        executionTarget: goal.executionTarget ?? null,
                    },
                    createdAt: this.at(iteration.run.queuedAtMinutes, 1),
                },
            );
            if (iteration.closes) {
                const criterion = criteria.find(
                    (entry) => entry.id === iteration.closes!.criterionId,
                );
                if (!criterion) {
                    throw new Error(
                        `Demo recorded fixture: the Goal has no criterion "${iteration.closes.criterionId}"`,
                    );
                }
                ticked.add(criterion.id);
                // The line `GoalOrchestratorService.patchDodCriterion` logs for a tick.
                events.push({
                    kind: 'dod',
                    message:
                        `Criterion "${criterion.text}" → done — ${ticked.size} done, ${waived} ` +
                        `waived, ${criteria.length - ticked.size - waived} open.`,
                    iteration: number,
                    metadata: { criterionId: criterion.id, status: 'done' },
                    createdAt: this.at(iteration.closes.atMinutes),
                });
            }
        }
        events.push({
            kind: 'complete',
            message: completion.message,
            iteration: iterations.length,
            metadata: { reasonCode: 'dod-complete', spentCents: 0 },
            createdAt: this.at(completion.atMinutes),
        });
        await this.repo(GoalEvent).insert(
            events.map((event) => ({
                goalId: goal.id,
                userId: this.input.ownerId,
                agentId: null,
                taskId: null,
                ...event,
                ...this.input.scope,
            })),
        );
        // The loop ran to its end: `done` is terminal, and only a `running` loop is advanced.
        await this.repo(Goal).update(
            { id: goal.id },
            {
                iteration: iterations.length,
                lastProgressIteration: iterations.length,
                loopStatus: 'done',
                loopStartedAt: this.at(loopStartedAtMinutes),
                activeAgentId: null,
                spentCents: 0,
            },
        );
    }

    /** The Tasks the Mission's planner filed, the way `MissionTickService` files them. */
    private async writeMissionPlan(mission: Mission): Promise<void> {
        const { plan, plannedAtMinutes } = this.fixture.mission;
        for (const [index, planned] of plan.entries()) {
            const agentId = planned.agentSlug ? this.agent(planned.agentSlug) : null;
            const task = await this.fileTask(
                {
                    title: planned.title,
                    description: planned.description,
                    labels: [MISSION_TASK_LABEL],
                    missionId: mission.id,
                    workId: this.input.projectWorkId,
                    agentId,
                    derivedFromPrivate: mission.visibility === 'private',
                    derivedFrom: { aggregate: 'mission', id: mission.id },
                },
                planned.status === 'done' ? TaskStatus.DONE : TaskStatus.TODO,
            );
            // Filed one after another, a second apart, in the plan's order.
            const filedAt = plannedAtMinutes + index / 60;
            const run = planned.run
                ? await this.writeRun(planned.run, task, agentId!, { missionId: mission.id })
                : null;
            await this.backdateTask(task.id, filedAt, planned.run, run);
        }
    }

    /** A direct chat with one Agent: the visitor asks, the Agent answers. Nothing is sent. */
    private async writeConversation(): Promise<void> {
        const { agentSlug, title, messages } = this.fixture.conversation;
        const agentId = this.agent(agentSlug);
        const stamp = this.input.scope;
        const openedAt = this.at(messages[0].atMinutes, -1000);
        const lastAt = this.at(messages[messages.length - 1].atMinutes, messages.length - 1);
        const conversation = await this.repo(Conversation).save(
            this.repo(Conversation).create({
                userId: this.input.ownerId,
                kind: 'direct',
                agentId,
                title,
                // A name a person chose: automatic titling (a model call) never touches it.
                titleSource: 'user',
                lastMessageAt: lastAt,
                createdAt: openedAt,
                updatedAt: lastAt,
                ...stamp,
            }),
        );
        let lastQuestionId: string | null = null;
        let lastMessageId: string | null = null;
        for (const [index, message] of messages.entries()) {
            const fromVisitor = message.by === 'user';
            // Stored as `sent` rows. `ConversationMessageService.send` is what dispatches the
            // Agent's reply; nothing here goes through it.
            const row: ConversationMessage = await this.repo(ConversationMessage).save(
                this.repo(ConversationMessage).create({
                    conversationId: conversation.id,
                    role: fromVisitor ? 'user' : 'assistant',
                    content: message.body,
                    authorType: fromVisitor ? 'user' : 'agent',
                    authorId: fromVisitor ? this.input.ownerId : agentId,
                    status: 'sent',
                    ...(fromVisitor
                        ? {}
                        : { model: this.fixture.model.id, replyToMessageId: lastQuestionId }),
                    createdAt: this.at(message.atMinutes, index),
                    ...stamp,
                }),
            );
            if (fromVisitor) lastQuestionId = row.id;
            lastMessageId = row.id;
        }
        // The visitor as owner (who has read the thread) and the Agent as member, as
        // `ConversationService.create` opens a direct Conversation with an Agent.
        await this.repo(ConversationParticipant).insert([
            {
                conversationId: conversation.id,
                participantType: 'user',
                participantId: this.input.ownerId,
                role: 'owner',
                joinedAt: openedAt,
                lastReadMessageId: lastMessageId,
                lastReadAt: lastAt,
                createdAt: openedAt,
                updatedAt: lastAt,
                ...stamp,
            },
            {
                conversationId: conversation.id,
                participantType: 'agent',
                participantId: agentId,
                role: 'member',
                joinedAt: openedAt,
                createdAt: openedAt,
                updatedAt: openedAt,
                ...stamp,
            },
        ]);
    }

    /** The activity entries, with the actor the Live Feed derives for them in production. */
    private async writeActivity(goal: Goal, mission: Mission): Promise<void> {
        const entries = this.fixture.activity.map((entry, index) => {
            const at = this.at(entry.atMinutes, index);
            const dto = withDerivedActor({
                userId: this.input.ownerId,
                status: ActivityStatus.COMPLETED,
                summary: entry.summary,
                ...this.activityKind(entry, goal, mission),
            });
            const actorLabel =
                dto.actorKind === 'agent' && dto.actorAgentId
                    ? (this.agentNames.get(dto.actorAgentId) ?? null)
                    : null;
            return this.repo(ActivityLog).create({
                ...dto,
                actorLabel,
                createdAt: at,
                updatedAt: at,
                ...this.input.scope,
            });
        });
        await this.repo(ActivityLog).insert(entries);
    }

    private activityKind(
        entry: DemoRecordedActivity,
        goal: Goal,
        mission: Mission,
    ): Pick<CreateActivityLogDto, 'actionType' | 'action' | 'details'> {
        const run = entry.run ? this.runs.get(entry.run) : undefined;
        switch (entry.type) {
            case 'goal_loop_started':
                return {
                    actionType: ActivityActionType.GOAL_LOOP_STARTED,
                    action: 'start',
                    details: { goalId: goal.id, iteration: 0 },
                };
            case 'goal_iteration_dispatched':
                return {
                    actionType: ActivityActionType.GOAL_ITERATION_DISPATCHED,
                    action: 'iteration',
                    details: {
                        goalId: goal.id,
                        iteration: run!.iteration,
                        agentId: run!.agentId,
                        taskId: run!.taskId,
                        runId: run!.id,
                        reasonCode: run!.reasonCode,
                    },
                };
            case 'agent_run_completed':
                return {
                    actionType: ActivityActionType.AGENT_RUN_COMPLETED,
                    action: 'run-completed',
                    details: {
                        runId: run!.id,
                        taskId: run!.taskId,
                        agentId: run!.agentId,
                        ...(run!.goalId ? { goalId: run!.goalId } : {}),
                        ...(run!.missionId ? { missionId: run!.missionId } : {}),
                        status: 'completed',
                        model: this.fixture.model.id,
                    },
                };
            case 'goal_dod_updated':
                return {
                    actionType: ActivityActionType.GOAL_DOD_UPDATED,
                    action: 'dod-patch',
                    details: { goalId: goal.id, criterionId: entry.criterionId, status: 'done' },
                };
            case 'goal_loop_completed':
                return {
                    actionType: ActivityActionType.GOAL_LOOP_COMPLETED,
                    action: 'done',
                    details: {
                        goalId: goal.id,
                        reasonCode: 'dod-complete',
                        iteration: this.fixture.goal.iterations.length,
                    },
                };
            case 'mission_tick':
                return {
                    actionType: ActivityActionType.MISSION_TICK,
                    action: 'mission.tick',
                    details: {
                        missionId: mission.id,
                        outcome: 'tasks-filed',
                        ideasCreated: 0,
                        ideasQueued: 0,
                        tasksFiled: this.fixture.mission.plan.length,
                        outstanding: null,
                        cap: null,
                        message: null,
                    },
                };
        }
    }

    /**
     * A Task through `TasksService`, filed in `todo` by the visitor (as a Goal or a Mission
     * files on its owner's behalf) and walked to `status` by the sync transition, which starts
     * no agent run.
     */
    private async fileTask(
        input: Omit<CreateTaskInput, 'status' | 'createdByType' | 'createdById'>,
        status: TaskStatus,
    ): Promise<Task> {
        const { ownerId, scope } = this.input;
        const task = await this.deps.tasks.create(
            ownerId,
            { ...input, status: TaskStatus.TODO, createdByType: 'user', createdById: ownerId },
            scope,
        );
        if (status !== TaskStatus.TODO) {
            await this.deps.tasks.syncTransition(ownerId, task.id, status, {}, scope);
        }
        return task;
    }

    /** One finished run of `task` by its Agent, and its transcript. */
    private async writeRun(
        recorded: DemoRecordedRun,
        task: Task,
        agentId: string,
        about: { goalId?: string; missionId?: string; iteration?: number; reasonCode?: string },
    ): Promise<AgentRun> {
        const { provider, id: model } = this.fixture.model;
        const startedAt = this.at(recorded.startedAtMinutes);
        const finishedAt = this.at(recorded.finishedAtMinutes);
        const durationMs = finishedAt.getTime() - startedAt.getTime();
        const run = await this.repo(AgentRun).save(
            this.repo(AgentRun).create({
                agentId,
                userId: this.input.ownerId,
                triggerKind: 'task',
                // Terminal: nothing that schedules, reaps, resumes or counts runs selects it.
                status: 'completed',
                startedAt,
                finishedAt,
                durationMs,
                summary: recorded.summary,
                taskId: task.id,
                workId: task.workId ?? null,
                totalTokens: recorded.totalTokens,
                costCents: 0,
                modelRouting: {
                    provider,
                    model,
                    accountId: null,
                    effort: 'not-applicable',
                    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
                    outcome: 'answered',
                    attempts: [{ provider, model, result: 'ok', ms: durationMs }],
                    recordedAt: finishedAt.toISOString(),
                },
                createdAt: this.at(recorded.queuedAtMinutes),
                ...this.input.scope,
            }),
        );
        await this.repo(AgentRunLog).insert(
            recorded.transcript.map((entry, index) => ({
                runId: run.id,
                ...transcriptLine(entry),
                // A millisecond per line keeps lines recorded in the same minute in order.
                createdAt: this.at(entry.atMinutes, index),
                ...this.input.scope,
            })),
        );
        this.runs.set(recorded.key, {
            id: run.id,
            taskId: task.id,
            agentId,
            goalId: about.goalId ?? null,
            missionId: about.missionId ?? null,
            iteration: about.iteration ?? null,
            reasonCode: about.reasonCode ?? null,
        });
        return run;
    }

    /**
     * Date the Task with its recorded history (filed, started, finished) and point its
     * latest-run denorm at its run, which the board's run chip reads.
     */
    private async backdateTask(
        taskId: string,
        filedAtMinutes: number,
        recorded: DemoRecordedRun | null,
        run: AgentRun | null,
    ): Promise<void> {
        const filedAt = this.at(filedAtMinutes);
        await this.repo(Task).update(
            { id: taskId },
            recorded && run
                ? {
                      createdAt: filedAt,
                      startedAt: this.at(recorded.startedAtMinutes),
                      completedAt: this.at(recorded.finishedAtMinutes),
                      updatedAt: this.at(recorded.finishedAtMinutes),
                      latestRunId: run.id,
                      latestRunStatus: run.status,
                  }
                : { createdAt: filedAt, updatedAt: filedAt },
        );
    }

    private agent(slug: string): string {
        return lookup(this.input.agentIds, slug, 'starter-kit agent');
    }

    /** `minutes` after the sandbox's creation (negative: before it), plus `ms`. */
    private at(minutes: number, ms = 0): Date {
        return new Date(this.input.createdAt.getTime() + Math.round(minutes * MINUTE_MS) + ms);
    }

    private repo<T extends ObjectLiteral>(entity: new () => T): Repository<T> {
        return this.deps.dataSource.getRepository(entity);
    }
}

/** A transcript line as the run executor writes it (`AgentRunService`'s capture). */
function transcriptLine(
    entry: DemoRecordedTranscriptEntry,
): Pick<AgentRunLog, 'level' | 'step' | 'message' | 'metadata'> {
    if (entry.kind !== 'tool-invocation') {
        const text = entry.text!;
        return {
            level: 'INFO',
            step: entry.kind,
            message: text,
            metadata: {
                role: entry.kind === 'user-message' ? 'user' : 'assistant',
                bytes: text.length,
            },
        };
    }
    return {
        level: entry.isError ? 'WARN' : 'INFO',
        step: 'tool-invocation',
        message: `Invoked tool "${entry.tool}"${entry.isError ? ' (returned error)' : ''}.`,
        metadata: {
            toolName: entry.tool,
            // Generated per sandbox like every id; it only pairs a call with its result.
            callId: `call_${randomBytes(8).toString('hex')}`,
            durationMs: entry.durationMs,
            argsPreview: entry.args,
            resultPreview: entry.result,
        },
    };
}

function lookup(ids: ReadonlyMap<string, string>, key: string, kind: string): string {
    const id = ids.get(key);
    if (id === undefined) throw new Error(`Demo recorded fixture: unknown ${kind} "${key}"`);
    return id;
}
