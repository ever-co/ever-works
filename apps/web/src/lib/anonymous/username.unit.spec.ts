import { describe, expect, it } from 'vitest';
import { isUsableUsername, normalizeUsername } from './username';

// The web copy of the API's handle rule (`UsernameAllocatorService.normalize`), minus its
// random fallback: the form must say what will be saved, and refuse what cannot be.
describe('normalizeUsername', () => {
    it.each([
        ['Jane Doe', 'jane-doe'],
        ["Alice O'Brien", 'alice-o-brien'],
        ['GITHUB.USER@x.io', 'github-user-x-io'],
        ['--jane--doe--', 'jane-doe'],
        ['jane-doe', 'jane-doe'],
        ['!!!', ''],
    ])('%p → %p', (input, expected) => {
        expect(normalizeUsername(input)).toBe(expected);
    });
});

describe('isUsableUsername', () => {
    it.each([[''], ['   '], ['jane'], ['Jane Doe'], ['abc']])('accepts %p', (input) => {
        expect(isUsableUsername(input)).toBe(true);
    });

    it.each([['!!!'], ['--'], ['ab'], ['ab!'], ['ünï']])(
        'refuses %p (nothing usable, or under 3 once normalized)',
        (input) => {
            expect(isUsableUsername(input)).toBe(false);
        },
    );
});
