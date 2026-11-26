import { DNS_WILDCARD_ENV_VAR, isDnsWildcardEnabled } from '../dns-wildcard';

describe('isDnsWildcardEnabled', () => {
    it('reads EVER_WORKS_DNS_WILDCARD', () => {
        expect(DNS_WILDCARD_ENV_VAR).toBe('EVER_WORKS_DNS_WILDCARD');
    });

    it.each(['true', 'TRUE', ' true '])('is on for %j', (value) => {
        expect(isDnsWildcardEnabled({ EVER_WORKS_DNS_WILDCARD: value })).toBe(true);
    });

    it.each([undefined, '', 'false', '1', 'yes'])('is off for %j', (value) => {
        expect(isDnsWildcardEnabled({ EVER_WORKS_DNS_WILDCARD: value })).toBe(false);
    });

    it('defaults to process.env', () => {
        const previous = process.env.EVER_WORKS_DNS_WILDCARD;
        try {
            process.env.EVER_WORKS_DNS_WILDCARD = 'true';
            expect(isDnsWildcardEnabled()).toBe(true);
            delete process.env.EVER_WORKS_DNS_WILDCARD;
            expect(isDnsWildcardEnabled()).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.EVER_WORKS_DNS_WILDCARD;
            else process.env.EVER_WORKS_DNS_WILDCARD = previous;
        }
    });
});
