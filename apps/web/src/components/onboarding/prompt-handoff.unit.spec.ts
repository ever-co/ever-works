import { describe, expect, it } from 'vitest';
import { landingTypeToWorkKind, readPromptHandoff, workKindLabel } from './prompt-handoff';

const BASE = 'https://app.ever.works/onboarding';

describe('readPromptHandoff — the ever.works home-page hand-off', () => {
    it('reads the prompt and the chosen type, and removes them and the funnel id from the hash', () => {
        const handoff = readPromptHandoff(
            `${BASE}#prompt=AI%20robots%20directory&corrId=abcdef12-3456&type=directory-website`,
        );

        // The wizard reads `corrId` itself when it mounts; here it is only removed.
        expect(handoff).toEqual({
            prompt: 'AI robots directory',
            kind: 'directory',
            cleanedHref: BASE,
        });
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

    it('answers null when there is no prompt', () => {
        expect(readPromptHandoff(BASE)).toBeNull();
        expect(readPromptHandoff(`${BASE}#type=blog`)).toBeNull();
        expect(readPromptHandoff(`${BASE}#prompt=%20%20`)).toBeNull();
    });

    it('only reads the hand-off on the onboarding page', () => {
        // `/tasks/new?prompt=…` and `/agents/new?prompt=…` own their `prompt`;
        // the dashboard's auto-opened wizard must not take it.
        expect(readPromptHandoff('https://app.ever.works/tasks/new?prompt=Fix%20login')).toBeNull();
        expect(readPromptHandoff('https://app.ever.works/agents/new#prompt=x')).toBeNull();
        expect(readPromptHandoff('https://app.ever.works/onboarding-help#prompt=x')).toBeNull();
        expect(readPromptHandoff('https://app.ever.works/en/onboarding#prompt=x')?.prompt).toBe(
            'x',
        );
        expect(readPromptHandoff('https://app.ever.works/onboarding/#prompt=x')?.prompt).toBe('x');
    });

    it('answers null for a URL it cannot parse', () => {
        expect(readPromptHandoff('not a url')).toBeNull();
    });
});

describe('landingTypeToWorkKind', () => {
    it('maps the home-page chips onto Work kinds', () => {
        expect(landingTypeToWorkKind('website')).toBe('website');
        expect(landingTypeToWorkKind('landing-page')).toBe('landing-page');
        expect(landingTypeToWorkKind('blog')).toBe('blog');
        expect(landingTypeToWorkKind('directory-website')).toBe('directory');
        expect(landingTypeToWorkKind('directory')).toBe('directory');
        expect(landingTypeToWorkKind('awesome-repo')).toBe('awesome-repo');
        expect(landingTypeToWorkKind(' Directory-Website ')).toBe('directory');
    });

    it('leaves the kind to the platform default for chips without a generated kind', () => {
        // `company` is reserved for the Register-Company flow; `repo` and `app`
        // need a repository URL; the rest have no Work kind of their own yet.
        for (const type of [
            'knowledge-base',
            'store',
            'company',
            'mission',
            'idea',
            'repo',
            'app',
            'x',
            '',
        ]) {
            expect(landingTypeToWorkKind(type)).toBeUndefined();
        }
        expect(landingTypeToWorkKind(null)).toBeUndefined();
    });
});

describe('workKindLabel', () => {
    it('names the kind the way the home page did', () => {
        expect(workKindLabel('directory')).toBe('Directory website');
        expect(workKindLabel('landing-page')).toBe('Landing page');
        expect(workKindLabel(undefined)).toBeUndefined();
    });
});
