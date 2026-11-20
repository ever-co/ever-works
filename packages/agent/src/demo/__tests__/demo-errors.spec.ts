import { DemoError, DemoFullError } from '../demo-errors';
import * as demoIndex from '../index';

describe('DemoFullError', () => {
    it('is a DemoError answering DEMO_FULL / 503 with the visitor-facing message', () => {
        const err = new DemoFullError();
        expect(err).toBeInstanceOf(DemoError);
        expect(err.code).toBe('DEMO_FULL');
        expect(err.httpStatus).toBe(503);
        expect(err.message).toBe('The demo is full right now — please try again in a few minutes.');
        expect(err.name).toBe('DemoFullError');
    });

    it('is exported from the demo index', () => {
        expect(demoIndex.DemoFullError).toBe(DemoFullError);
    });
});
