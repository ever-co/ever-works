import type { Repository } from 'typeorm';
import { WorkGenerationHistoryRepository } from '../work-generation-history.repository';
import { WorkGenerationHistory } from '@src/entities/work-generation-history.entity';

describe('WorkGenerationHistoryRepository', () => {
    let repository: jest.Mocked<Pick<Repository<WorkGenerationHistory>, 'find'>>;
    let service: WorkGenerationHistoryRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
        };

        service = new WorkGenerationHistoryRepository(
            repository as unknown as Repository<WorkGenerationHistory>,
        );
    });

    it('returns early for an empty work list', async () => {
        await expect(service.findLatestPositiveItemCounts([])).resolves.toEqual(new Map());
        expect(repository.find).not.toHaveBeenCalled();
    });

    it('fetches history in bounded pages until every work has a count', async () => {
        repository.find
            .mockResolvedValueOnce(
                Array.from({ length: 20 }, (_, index) => ({
                    workId: 'dir-a',
                    totalItemsCount: 100 - index,
                })) as WorkGenerationHistory[],
            )
            .mockResolvedValueOnce([
                {
                    workId: 'dir-b',
                    totalItemsCount: 42,
                },
            ] as WorkGenerationHistory[]);

        const result = await service.findLatestPositiveItemCounts(['dir-a', 'dir-b']);

        expect(repository.find).toHaveBeenNthCalledWith(1, {
            where: expect.any(Object),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 20,
            skip: 0,
        });
        expect(repository.find).toHaveBeenNthCalledWith(2, {
            where: expect.any(Object),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 20,
            skip: 20,
        });
        expect(result).toEqual(
            new Map([
                ['dir-a', 100],
                ['dir-b', 42],
            ]),
        );
    });

    it('deduplicates requested work ids before querying', async () => {
        repository.find.mockResolvedValueOnce([
            {
                workId: 'dir-a',
                totalItemsCount: 7,
            },
        ] as WorkGenerationHistory[]);

        await service.findLatestPositiveItemCounts(['dir-a', 'dir-a']);

        expect(repository.find).toHaveBeenCalledWith({
            where: expect.objectContaining({
                workId: expect.anything(),
            }),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 10,
            skip: 0,
        });
    });
});

describe('WorkGenerationHistoryRepository: provider text is redacted before it is stored', () => {
    const masked = `sk-proj-${'*'.repeat(40)}wxyz`;
    let repository: {
        update: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let service: WorkGenerationHistoryRepository;

    beforeEach(() => {
        repository = {
            update: jest.fn().mockResolvedValue({}),
            findOne: jest.fn(),
            create: jest.fn((record) => record),
            save: jest.fn(async (record) => record),
        };
        service = new WorkGenerationHistoryRepository(
            repository as unknown as Repository<WorkGenerationHistory>,
        );
    });

    it('updateEntry redacts the errorMessage and the warnings', async () => {
        repository.findOne.mockResolvedValue(null);

        await service.updateEntry('history-1', {
            errorMessage: `Incorrect API key provided: ${masked}.`,
            warnings: ['Search failed: Authorization: Bearer abc123def456'],
        } as never);

        expect(repository.update).toHaveBeenCalledWith(
            'history-1',
            expect.objectContaining({
                errorMessage: 'Incorrect API key provided: [redacted secret].',
                warnings: ['Search failed: Authorization: Bearer [redacted secret]'],
            }),
        );
    });

    it('updateEntry keeps the credits message as it is', async () => {
        repository.findOne.mockResolvedValue(null);

        await service.updateEntry('history-1', {
            errorMessage:
                'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
        } as never);

        expect(repository.update).toHaveBeenCalledWith(
            'history-1',
            expect.objectContaining({
                errorMessage:
                    'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
            }),
        );
    });

    it('appendLogs redacts each new log message', async () => {
        repository.findOne.mockResolvedValue({
            id: 'history-1',
            logs: [{ message: 'Generation started' }],
        });

        await service.appendLogs('history-1', [
            {
                timestamp: '2026-11-20T22:31:06.621Z',
                level: 'error',
                source: 'pipeline',
                event: 'message',
                message: `Parent agent: stream error - Incorrect API key provided: ${masked}.`,
            },
        ]);

        expect(repository.update).toHaveBeenCalledWith('history-1', {
            logs: [
                { message: 'Generation started' },
                expect.objectContaining({
                    message:
                        'Parent agent: stream error - Incorrect API key provided: [redacted secret].',
                }),
            ],
        });
    });

    it('createEntry redacts the warnings', async () => {
        await service.createEntry({ workId: 'work-1', warnings: [`invalid key ${masked}`] });

        expect(repository.create).toHaveBeenCalledWith(
            expect.objectContaining({ warnings: ['invalid key [redacted secret]'] }),
        );
    });
});
