import {
    DEMO_WORKER_HEADER,
    DEMO_WORKER_HEADER_VALUE,
    isDemoWorkerHeader,
} from '../demo-worker-handshake';
import * as demoIndex from '../index';

/**
 * The DEMO drift handshake's wire contract: the Trigger.dev worker sends it
 * (`TriggerInternalApiClient`), the API reads it (`TriggerInternalController`).
 */
describe('demo worker handshake', () => {
    it('is the x-ever-works-demo header with the value 1', () => {
        expect(DEMO_WORKER_HEADER).toBe('x-ever-works-demo');
        expect(DEMO_WORKER_HEADER_VALUE).toBe('1');
    });

    it.each([
        ['1', true],
        [' 1 ', true],
        [['1', '1'], true],
        [undefined, false],
        ['', false],
        ['0', false],
        ['true', false],
        [[], false],
    ] as const)('reads %j as a demo worker: %s', (value, expected) => {
        expect(isDemoWorkerHeader(value as string | string[] | undefined)).toBe(expected);
    });

    it('is exported from the demo index', () => {
        expect(demoIndex.DEMO_WORKER_HEADER).toBe(DEMO_WORKER_HEADER);
        expect(demoIndex.isDemoWorkerHeader).toBe(isDemoWorkerHeader);
    });
});
