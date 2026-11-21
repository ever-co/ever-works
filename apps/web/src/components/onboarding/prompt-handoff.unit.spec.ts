import { describe, expect, it } from 'vitest';
import { readPromptHandoff } from './prompt-handoff';

const BASE = 'https://app.ever.works/onboarding';

describe('readPromptHandoff — the ever.works home-page hand-off', () => {
    it('reads the prompt, the funnel id and the chosen type from the hash', () => {
        const handoff = readPromptHandoff(
            `${BASE}#prompt=AI%20robots%20directory&corrId=abcdef12-3456&type=directory-website`,
        );

        expect(handoff).toEqual({
            prompt: 'AI robots directory',
            correlationId: 'abcdef12-3456',
            cleanedHref: BASE,
        });
        // The chip is consumed (stripped) but not mapped onto a Work kind.
        expect(handoff).not.toHaveProperty('kind');
    });

    it('removes only what it consumed, so other hand-off keys survive', () => {
        const handoff = readPromptHandoff(`${BASE}#prompt=Blog&type=blog&attachments=u1,u2`);

        expect(handoff?.cleanedHref).toBe(`${BASE}#attachments=u1%2Cu2`);
    });

    it('strips the type too, so the URL no longer reads #type=directory-website', () => {
        const handoff = readPromptHandoff(`${BASE}#prompt=x&type=directory-website`);

        expect(handoff?.cleanedHref).toBe(BASE);
    });

    it('accepts the legacy ?prompt= query form', () => {
        const handoff = readPromptHandoff(`${BASE}?prompt=Landing%20page%20for%20my%20cafe&utm=x`);

        expect(handoff?.prompt).toBe('Landing page for my cafe');
        expect(handoff?.cleanedHref).toBe(`${BASE}?utm=x`);
    });

    it('sanitises and bounds the prompt', () => {
        const long = 'a'.repeat(6000);
        const handoff = readPromptHandoff(
            `${BASE}#prompt=${encodeURIComponent(`hi\u0007 ${long}`)}`,
        );

        expect(handoff?.prompt.startsWith('hi ')).toBe(true);
        expect(handoff?.prompt).not.toContain('\u0007');
        expect(handoff?.prompt.length).toBeLessThanOrEqual(5000);
    });

    it('drops a funnel id that is not a plain token', () => {
        const handoff = readPromptHandoff(`${BASE}#prompt=x&corrId=%3Cscript%3E`);

        expect(handoff?.correlationId).toBeUndefined();
    });

    it('answers null when there is no prompt', () => {
        expect(readPromptHandoff(BASE)).toBeNull();
        expect(readPromptHandoff(`${BASE}#type=blog`)).toBeNull();
        expect(readPromptHandoff(`${BASE}#prompt=%20%20`)).toBeNull();
    });

    it('answers null for a URL it cannot parse', () => {
        expect(readPromptHandoff('not a url')).toBeNull();
    });
});
