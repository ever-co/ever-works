import { describe, expect, it } from 'vitest';
import { resolveInitialPrompt } from './initial-prompt';

const base = { isGenerated: false, demoMode: false } as const;

describe('resolveInitialPrompt', () => {
    it('demo off: never uses the description (behaviour unchanged)', () => {
        expect(resolveInitialPrompt({ ...base, workDescription: 'seeded prompt' })).toBe('');
        expect(
            resolveInitialPrompt({
                ...base,
                lastPrompt: 'last',
                initialPrompt: 'first',
                workDescription: 'd',
            }),
        ).toBe('last');
        expect(
            resolveInitialPrompt({ ...base, initialPrompt: 'first', workDescription: 'd' }),
        ).toBe('first');
    });

    it('demo on, never generated: prefills from the description', () => {
        expect(
            resolveInitialPrompt({ ...base, demoMode: true, workDescription: 'seeded prompt' }),
        ).toBe('seeded prompt');
    });

    it('demo on, already generated: does not use the description', () => {
        expect(
            resolveInitialPrompt({
                isGenerated: true,
                demoMode: true,
                workDescription: 'seeded prompt',
            }),
        ).toBe('');
    });

    it('demo on: a recorded prompt still wins over the description', () => {
        expect(
            resolveInitialPrompt({
                ...base,
                demoMode: true,
                initialPrompt: 'first',
                workDescription: 'd',
            }),
        ).toBe('first');
    });

    it('demo on: a missing description yields an empty prompt', () => {
        expect(resolveInitialPrompt({ ...base, demoMode: true, workDescription: null })).toBe('');
    });
});
