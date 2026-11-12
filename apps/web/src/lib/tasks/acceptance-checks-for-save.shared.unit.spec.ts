import { describe, expect, it } from 'vitest';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import {
    acceptanceChecksForSave,
    acceptanceChecksSaveProblem,
} from './acceptance-checks-for-save.shared';

/** `AcceptanceCheckDto`'s id rule (`packages/agent/src/dto/acceptance-check.dto.ts`). */
const API_ID = /^[a-z0-9][a-z0-9-_]{0,40}$/;

const check = (overrides: Partial<TaskAcceptanceCheck>): TaskAcceptanceCheck => ({
    id: 'unit-tests',
    name: 'Unit tests',
    kind: 'test',
    command: 'pnpm test',
    required: true,
    ...overrides,
});

describe('acceptanceChecksForSave', () => {
    it('drops a row without a command (the Task-detail editor sent it and got a 400)', () => {
        expect(
            acceptanceChecksForSave([check({}), check({ id: 'empty', command: '   ' })]).map(
                (c) => c.id,
            ),
        ).toEqual(['unit-tests']);
    });

    it('names a nameless row after its command — the API requires a name', () => {
        const [row] = acceptanceChecksForSave([check({ name: '  ', command: 'pnpm lint' })]);
        expect(row!.name).toBe('pnpm lint');
    });

    it('re-derives an id longer than the API allows from the name, within 41 characters', () => {
        const [row] = acceptanceChecksForSave([
            check({
                id: 'run-the-full-end-to-end-test-suite-on-staging',
                name: 'Run the full end to end test suite on staging',
            }),
        ]);
        expect(row!.id).toMatch(API_ID);
        expect(row!.id.length).toBeLessThanOrEqual(41);
    });

    it('keeps re-derived ids unique, and never takes an id a valid row already holds', () => {
        const long = 'x'.repeat(50);
        const rows = acceptanceChecksForSave([
            check({ id: 'x'.repeat(41), name: 'a' }),
            check({ id: long, name: 'b' }),
            check({ id: long, name: 'c' }),
        ]);
        const ids = rows.map((r) => r.id);
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) expect(id).toMatch(API_ID);
    });

    it('drops a timeout below 1 and caps one above an hour', () => {
        const rows = acceptanceChecksForSave([
            check({ id: 'a', timeoutSec: 0 }),
            check({ id: 'b', timeoutSec: 9000 }),
            check({ id: 'c', timeoutSec: 90 }),
        ]);
        expect(rows[0]).not.toHaveProperty('timeoutSec');
        expect(rows[1]!.timeoutSec).toBe(3600);
        expect(rows[2]!.timeoutSec).toBe(90);
    });

    it('keeps every other field (phase, mountDir, envPassthrough)', () => {
        const [row] = acceptanceChecksForSave([
            check({ phase: 'setup', mountDir: 'api', envPassthrough: ['CI'] }),
        ]);
        expect(row).toMatchObject({ phase: 'setup', mountDir: 'api', envPassthrough: ['CI'] });
    });
});

// Review of #3164 (finding 4): the two DTO limits the save cannot fix by
// itself — `@ArrayMaxSize(20)` on acceptanceChecks (apps/api/src/tasks/tasks.dto.ts)
// and `@MaxLength(2000)` on the command — are named instead of sent for a 400.
describe('acceptanceChecksSaveProblem', () => {
    const rows = (count: number) =>
        Array.from({ length: count }, (_, i) => check({ id: `c-${i}`, name: `Check ${i}` }));

    it('accepts 20 checks with commands of up to 2000 characters', () => {
        const atLimit = rows(20);
        atLimit[0] = check({ id: 'long', command: 'x'.repeat(2000) });
        expect(acceptanceChecksSaveProblem(atLimit)).toBeNull();
        expect(acceptanceChecksSaveProblem([])).toBeNull();
    });

    it('names a 21st check', () => {
        expect(acceptanceChecksSaveProblem(rows(21))).toEqual({
            reason: 'tooManyChecks',
            count: 21,
            max: 20,
        });
    });

    it('names the check whose command is over 2000 characters', () => {
        expect(
            acceptanceChecksSaveProblem([
                check({}),
                check({ id: 'e2e', name: 'E2E', command: 'y'.repeat(2001) }),
            ]),
        ).toEqual({ reason: 'commandTooLong', name: 'E2E', length: 2001, max: 2000 });
    });

    it('counts characters, not UTF-16 units, as the API validator does', () => {
        // 1500 emoji = 3000 UTF-16 units but 1500 characters: the API accepts it.
        expect(acceptanceChecksSaveProblem([check({ command: '🚀'.repeat(1500) })])).toBeNull();
    });
});
