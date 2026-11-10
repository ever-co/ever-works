import {
    FLEET_JOB_PAYLOAD_HEAD_CHARS,
    readLeadingJsonStringMembers,
} from '../fleet-job-payload-head';

const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const TASK = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const AGENT = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const USER = 'dddddddd-dddd-4ddd-8ddd-000000000001';

const ids = (head: unknown) => readLeadingJsonStringMembers(head, ['runId', 'taskId']);
const headOf = (value: unknown) => JSON.stringify(value).slice(0, FLEET_JOB_PAYLOAD_HEAD_CHARS);

/**
 * Reading the run and task ids out of the HEAD of a stored job payload
 * (PR #3131 second review, N2 and N5): the run-statistics read no longer
 * parses whole payloads, so what it does read must give the same answer as
 * `JSON.parse` would for the two ids — and nothing else may ever make it
 * throw or wander.
 */
describe('readLeadingJsonStringMembers', () => {
    /** The payload `FleetRunRouterService.enqueueAgentTask` writes: ids first, the heavy parts after. */
    const production = (instructions: string) => ({
        taskId: TASK,
        agentId: AGENT,
        userId: USER,
        runId: RUN,
        execution: { provider: 'claude-code', instructions },
        workspace: { repoUrl: 'https://example.invalid/r.git', branch: 'task/t1' },
        acceptanceChecks: [{ id: 'unit', command: 'pnpm test' }],
    });

    it('reads both ids from the head of a production-shaped payload, whatever the rest weighs', () => {
        for (const size of [0, 1_000, 128_000]) {
            const payload = production(
                'Lorem ipsum "quoted" \\n {"runId":"not-this-one"} '.repeat(size / 50),
            );
            expect(ids(headOf(payload))).toEqual({ runId: RUN, taskId: TASK });
        }
    });

    it('agrees with JSON.parse for every document that fits in the head', () => {
        const documents: unknown[] = [
            { runId: RUN, taskId: TASK },
            { taskId: TASK, runId: RUN, execution: { instructions: 'x' } },
            { a: 1, b: true, c: null, d: -1.5e3, runId: RUN, taskId: TASK },
            {
                nested: { runId: 'inner', taskId: 'inner' },
                list: [{ runId: 'in-list' }],
                runId: RUN,
                taskId: TASK,
            },
            { text: 'he said "runId":"forged", and {"taskId":"forged"}', runId: RUN, taskId: TASK },
            { runId: '', taskId: '   ' },
            { runId: 'emoji \u{1F600} é ü', taskId: 'quote " back\\slash \n tab\t' },
            { runId: 'nul \u0000 inside', taskId: 'lone \ud83d surrogate' },
            { taskId: TASK },
            { runId: RUN },
            {},
        ];
        for (const document of documents) {
            const expected = document as { runId?: unknown; taskId?: unknown };
            for (const text of [
                JSON.stringify(document),
                JSON.stringify(document, null, 2),
                ` ${JSON.stringify(document)}`,
            ]) {
                expect(text.length).toBeLessThanOrEqual(FLEET_JOB_PAYLOAD_HEAD_CHARS);
                expect(ids(text)).toEqual({
                    runId: typeof expected.runId === 'string' ? expected.runId : null,
                    taskId: typeof expected.taskId === 'string' ? expected.taskId : null,
                });
            }
        }
    });

    it('reads an id only when it is a JSON string — a number, an object, a list, null or a boolean is not one', () => {
        for (const value of [42, { nested: true }, ['x'], null, true]) {
            expect(ids(JSON.stringify({ runId: value, taskId: TASK }))).toEqual({
                runId: null,
                taskId: TASK,
            });
        }
    });

    it('never takes a nested member, or text inside a string, for a top-level id', () => {
        expect(
            ids(JSON.stringify({ workspace: { runId: 'inner' }, steps: [{ taskId: 'inner' }] })),
        ).toEqual({
            runId: null,
            taskId: null,
        });
        expect(ids(JSON.stringify({ note: '"runId":"forged","taskId":"forged"' }))).toEqual({
            runId: null,
            taskId: null,
        });
        // A nested key that comes BEFORE the real one does not shadow it.
        expect(ids(JSON.stringify({ workspace: { runId: 'inner' }, runId: RUN }))).toEqual({
            runId: RUN,
            taskId: null,
        });
    });

    it('the first occurrence of a key wins, and a key that is present but not a string is settled', () => {
        expect(ids(`{"runId":"${RUN}","runId":"second","taskId":"${TASK}"}`)).toEqual({
            runId: RUN,
            taskId: TASK,
        });
        expect(ids(`{"runId":7,"runId":"second"}`)).toEqual({ runId: null, taskId: null });
    });

    it('an id beyond the head, or cut by it, reads as no id — never as half of one', () => {
        const late = { execution: { instructions: 'x'.repeat(2_000) }, runId: RUN, taskId: TASK };
        expect(ids(headOf(late))).toEqual({ runId: null, taskId: null });

        const text = JSON.stringify({ taskId: TASK, runId: RUN });
        for (let cut = 0; cut < text.length; cut += 1) {
            const read = ids(text.slice(0, cut));
            expect([null, TASK]).toContain(read.taskId);
            expect([null, RUN]).toContain(read.runId);
        }
        // Cut just short of the closing quote: nothing, not a truncated id.
        expect(ids(text.slice(0, text.indexOf(RUN) + RUN.length))).toEqual({
            runId: null,
            taskId: TASK,
        });
    });

    it('anything that is not an object document reads as no ids, and never throws (review N5)', () => {
        for (const head of [
            '',
            '   ',
            'null',
            'true',
            '42',
            '"just a string"',
            JSON.stringify([{ runId: RUN }]),
            '{',
            '{"runId"',
            '{"runId":',
            '{"runId": "truncated',
            '{runId:"x"}',
            "{'runId':'x'}",
            '{"runId":"bad \\x escape","taskId":"ok"}',
            '\u0000\u0001garbage',
            '}{][',
            null,
            undefined,
            42,
            {},
            ['{"runId":"x"}'],
        ]) {
            expect(() => ids(head)).not.toThrow();
            const read = ids(head);
            expect(read.runId).toBeNull();
        }
        // A bad escape spoils only the value it is in.
        expect(ids('{"runId":"bad \\x escape","taskId":"ok"}')).toEqual({
            runId: null,
            taskId: 'ok',
        });
        // Text that stops making sense ends the read with what was found before it
        // (a prefix can never vouch for the rest of a document anyway).
        expect(ids('{"runId":"x" "taskId":"y"}')).toEqual({ runId: 'x', taskId: null });
    });

    it('asks for nothing, gets nothing', () => {
        expect(readLeadingJsonStringMembers('{"runId":"x"}', [])).toEqual({});
    });

    it('is one pass: a megabyte of the worst input returns at once', () => {
        const size = 1024 * 1024;
        const worst = [
            `{"k":"${'\\'.repeat(size)}`,
            `{${'"a":1,'.repeat(size / 6)}`,
            `{"a":${'['.repeat(size)}`,
            `{"a":${'{"b":'.repeat(size / 5)}`,
            `{"a":"${'x'.repeat(size)}`,
            `{${' '.repeat(size)}`,
            `{"${'"'.repeat(size)}`,
        ];
        for (const head of worst) {
            const started = performance.now();
            expect(ids(head)).toEqual({ runId: null, taskId: null });
            expect(performance.now() - started).toBeLessThan(250);
        }
    });
});
