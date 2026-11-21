import { DemoFeatureDisabledError } from '../demo-errors';
import {
    DEMO_REPO_LEDGER_UNBOUND_MESSAGE,
    type DemoRepoLedgerPort,
} from '../demo-repo-ledger.port';
import { demoRepoLedgerGate, tagAndRecordDemoRepository } from '../demo-repo-ledger.helpers';

/**
 * Platform demo mode — the two pieces every repository create on a demo instance shares
 * (`EverWorksGitProvider.createRepository`, `GitFacadeService.createRepository*`): the ledger
 * gate with its log-once, and "tag, record, name the repository on failure, rethrow".
 */

function loggerDouble() {
    return { error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

function ledgerDouble(): DemoRepoLedgerPort & { record: jest.Mock } {
    return { record: jest.fn().mockResolvedValue(undefined) };
}

describe('demoRepoLedgerGate', () => {
    const ORIGINAL_DEMO = process.env.DEMO;

    afterEach(() => {
        if (ORIGINAL_DEMO === undefined) delete process.env.DEMO;
        else process.env.DEMO = ORIGINAL_DEMO;
    });

    it('answers undefined with the demo off, bound or not, and logs nothing', () => {
        delete process.env.DEMO;
        const logger = loggerDouble();
        const gate = demoRepoLedgerGate(logger);

        expect(gate(undefined)).toBeUndefined();
        expect(gate(ledgerDouble())).toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('answers the bound ledger with the demo on', () => {
        process.env.DEMO = 'true';
        const ledger = ledgerDouble();
        const logger = loggerDouble();

        expect(demoRepoLedgerGate(logger)(ledger)).toBe(ledger);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('refuses every create with the demo on and none bound, logging once per gate', () => {
        process.env.DEMO = 'true';
        const logger = loggerDouble();
        const gate = demoRepoLedgerGate(logger);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            expect(() => gate(undefined)).toThrow(DemoFeatureDisabledError);
        }
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(DEMO_REPO_LEDGER_UNBOUND_MESSAGE);

        // A second consumer has its own flag, as each class's field was.
        expect(() => demoRepoLedgerGate(logger)(undefined)).toThrow(DemoFeatureDisabledError);
        expect(logger.error).toHaveBeenCalledTimes(2);
    });
});

describe('tagAndRecordDemoRepository', () => {
    const repository = {
        sandboxUserId: 'sandbox-1',
        owner: 'ever-works-cloud',
        name: 'demo-1a2b3c4d-tools',
    };

    it('tags, then reads the id, then records, in that order', async () => {
        const order: string[] = [];
        const ledger = ledgerDouble();
        ledger.record.mockImplementation(async () => {
            order.push('record');
        });

        await tagAndRecordDemoRepository({
            ...repository,
            ledger,
            logger: loggerDouble(),
            tag: async () => {
                order.push('tag');
            },
            githubId: async () => {
                order.push('id');
                return 812345678;
            },
        });

        expect(order).toEqual(['tag', 'id', 'record']);
        expect(ledger.record).toHaveBeenCalledWith({ ...repository, githubId: 812345678 });
    });

    it('records a null id as null', async () => {
        const ledger = ledgerDouble();

        await tagAndRecordDemoRepository({
            ...repository,
            ledger,
            logger: loggerDouble(),
            tag: async () => undefined,
            githubId: () => null,
        });

        expect(ledger.record).toHaveBeenCalledWith({ ...repository, githubId: null });
    });

    it('names the repository, its id and its owner at error level when the record fails, and rethrows', async () => {
        const ledger = ledgerDouble();
        const failure = new Error('database is locked');
        ledger.record.mockRejectedValue(failure);
        const logger = loggerDouble();

        await expect(
            tagAndRecordDemoRepository({
                ...repository,
                ledger,
                logger,
                tag: async () => undefined,
                githubId: () => 812345678,
            }),
        ).rejects.toBe(failure);

        expect(logger.error).toHaveBeenCalledTimes(1);
        const [line] = logger.error.mock.calls[0] as [string];
        expect(line).toContain('ever-works-cloud/demo-1a2b3c4d-tools (id 812345678)');
        expect(line).toContain('for user sandbox-1');
        expect(line).toContain('the sweeper will not delete it: database is locked');
    });

    it('rethrows a non-Error rejection unchanged, logging its text', async () => {
        const ledger = ledgerDouble();
        ledger.record.mockRejectedValue('remote call failed');
        const logger = loggerDouble();

        await expect(
            tagAndRecordDemoRepository({
                ...repository,
                ledger,
                logger,
                tag: async () => undefined,
                githubId: () => null,
            }),
        ).rejects.toBe('remote call failed');
        expect(logger.error.mock.calls[0][0]).toContain(': remote call failed');
    });
});
