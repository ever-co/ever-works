import { describe, expect, it } from 'vitest';
import { validatorLength } from './text-length';

describe('validatorLength (class-validator / validator.js isLength)', () => {
    it.each([
        ['', 0],
        ['abc', 3],
        ['🚀', 1],
        ['🚀🚀', 2],
        ['❤️', 1],
        ['é', 1],
        ['é', 2],
        ['👍🏽', 2],
        ['a️', 1],
    ])('%j counts %i', (text, expected) => {
        expect(validatorLength(text)).toBe(expected);
    });
});
