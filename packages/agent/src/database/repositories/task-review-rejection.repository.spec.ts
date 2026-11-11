import { In, IsNull, QueryFailedError } from 'typeorm';
import { TaskReviewRejectionRepository } from './task-review-rejection.repository';

/**
 * Item 11 (10-09 fleet handover) — a redelivered GitHub `created` webhook must
 * not record the same finding twice. The unique (taskId, sourceKey) index is
 * the guarantee; the repository turns both the known duplicate and a lost race
 * into "nothing recorded" (`null`), never a second row or a 500.
 */
describe('TaskReviewRejectionRepository.record — source dedup', () => {
    const input = {
        taskId: 'task-1',
        source: 'pull-request' as const,
        feedback: 'Major: the guard is missing on the retry path.',
        sourceKey: 'pull_request_review_comment:42',
    };

    function build(over: { existing?: unknown; saveError?: unknown } = {}) {
        const repository = {
            findOne: jest.fn(async () => over.existing ?? null),
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => {
                if (over.saveError) throw over.saveError;
                return { id: 'row-1', ...row };
            }),
        };
        return { repository, rejections: new TaskReviewRejectionRepository(repository as never) };
    }

    it('records the first delivery with its source key', async () => {
        const { repository, rejections } = build();
        await expect(rejections.record(input)).resolves.toMatchObject({
            sourceKey: input.sourceKey,
        });
        expect(repository.findOne).toHaveBeenCalledWith({
            where: { taskId: 'task-1', sourceKey: input.sourceKey },
        });
    });

    it('records nothing for a redelivery of the same source', async () => {
        const { repository, rejections } = build({ existing: { id: 'row-1' } });
        await expect(rejections.record(input)).resolves.toBeNull();
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('turns a lost race on the unique index into "nothing recorded"', async () => {
        const duplicate = new QueryFailedError('INSERT', [], new Error('UNIQUE constraint failed'));
        const { rejections } = build({ saveError: duplicate });
        await expect(rejections.record(input)).resolves.toBeNull();
    });

    it('still throws a real failure, and never dedups a row without a source', async () => {
        const { rejections } = build({ saveError: new Error('db down') });
        await expect(rejections.record(input)).rejects.toThrow('db down');
        const { repository, rejections: plain } = build({ existing: { id: 'x' } });
        await expect(plain.record({ ...input, sourceKey: null })).resolves.toMatchObject({
            sourceKey: null,
        });
        expect(repository.findOne).not.toHaveBeenCalled();
    });
});

/**
 * Review feedback reaches the next run — the CARRIED state, kept in the two
 * columns that already exist (`consumedByRunId` set, `consumedAt` not yet).
 * Every write is CAS-guarded on `consumedAt IS NULL`, so a consumed row is
 * never touched again, and a carry takes a row only from nobody, from the
 * same run, or from a run the caller saw give it up.
 */
describe('TaskReviewRejectionRepository — carried review feedback', () => {
    function build() {
        const repository = {
            findOne: jest.fn(async () => null as unknown),
            find: jest.fn(async () => [] as unknown[]),
            update: jest.fn(async () => ({ affected: 2 })),
        };
        return { repository, rejections: new TaskReviewRejectionRepository(repository as never) };
    }

    it('scopes the read by pull request IN the query: rows with none, and rows about the open one', async () => {
        const { repository, rejections } = build();
        await rejections.findOpenForTask('task-1', { openPullRequest: 5038 });
        const [{ where, order, take }] = repository.find.mock.calls[0] as unknown as [
            { where: unknown[]; order: unknown; take: number },
        ];
        expect(where).toEqual([
            { taskId: 'task-1', consumedAt: IsNull(), prNumber: IsNull() },
            { taskId: 'task-1', consumedAt: IsNull(), prNumber: 5038 },
        ]);
        expect(order).toEqual({ createdAt: 'ASC' });
        expect(take).toBe(50);
    });

    it('with no open pull request, only the rows that name none — and no age cutoff at all', async () => {
        const { repository, rejections } = build();
        await rejections.findOpenForTask('task-1', { openPullRequest: null, limit: 500 });
        const [{ where, take }] = repository.find.mock.calls[0] as unknown as [
            { where: Array<Record<string, unknown>>; take: number },
        ];
        expect(where).toEqual([{ taskId: 'task-1', consumedAt: IsNull(), prNumber: IsNull() }]);
        expect(where[0]).not.toHaveProperty('createdAt');
        expect(take).toBe(100);
    });

    it('carries from nobody, then from the runs that gave the rows up — never from a consumed row', async () => {
        const { repository, rejections } = build();
        await rejections.carryForRun(['a', 'b'], 'run-3', ['run-2', 'run-3', '']);
        expect(repository.update).toHaveBeenNthCalledWith(
            1,
            { id: In(['a', 'b']), consumedAt: IsNull(), consumedByRunId: IsNull() },
            { consumedByRunId: 'run-3' },
        );
        expect(repository.update).toHaveBeenNthCalledWith(
            2,
            { id: In(['a', 'b']), consumedAt: IsNull(), consumedByRunId: In(['run-2']) },
            { consumedByRunId: 'run-3' },
        );
        expect(repository.find).toHaveBeenCalledWith({
            where: { id: In(['a', 'b']), consumedByRunId: 'run-3', consumedAt: IsNull() },
            order: { createdAt: 'ASC' },
        });
        await expect(rejections.carryForRun([], 'run-3')).resolves.toEqual([]);
    });

    it('settles: completed stamps consumedAt, failed hands the rows back — only rows still carried', async () => {
        const { repository, rejections } = build();
        await expect(rejections.markCarriedConsumed('run-3')).resolves.toBe(2);
        expect(repository.update).toHaveBeenLastCalledWith(
            { consumedByRunId: 'run-3', consumedAt: IsNull() },
            { consumedAt: expect.any(Date) },
        );
        await expect(rejections.releaseCarried('run-3')).resolves.toBe(2);
        expect(repository.update).toHaveBeenLastCalledWith(
            { consumedByRunId: 'run-3', consumedAt: IsNull() },
            { consumedByRunId: null },
        );
        // Only the named rows — the ones a plan could not show.
        await rejections.releaseCarried('run-3', ['b']);
        expect(repository.update).toHaveBeenLastCalledWith(
            { consumedByRunId: 'run-3', consumedAt: IsNull(), id: In(['b']) },
            { consumedByRunId: null },
        );
        const calls = repository.update.mock.calls.length;
        await expect(rejections.releaseCarried('run-3', [])).resolves.toBe(0);
        expect(repository.update.mock.calls.length).toBe(calls);
    });

    it('the resume path’s pending read skips a row retired on deploy (consumed by no run)', async () => {
        const { repository, rejections } = build();
        await rejections.findPendingForTask('task-1', 3);
        expect(repository.find).toHaveBeenCalledWith({
            where: { taskId: 'task-1', consumedByRunId: IsNull(), consumedAt: IsNull() },
            order: { createdAt: 'ASC' },
            take: 3,
        });
    });

    it('knows whether anything is open', async () => {
        const { repository, rejections } = build();
        await expect(rejections.hasOpenForTask('task-1')).resolves.toBe(false);
        repository.findOne.mockResolvedValueOnce({ id: 'a' });
        await expect(rejections.hasOpenForTask('task-1')).resolves.toBe(true);
    });
});
