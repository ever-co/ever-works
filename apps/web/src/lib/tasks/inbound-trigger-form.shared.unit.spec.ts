import { describe, expect, it } from 'vitest';
import {
    isValidTriggerReplayWindow,
    MAX_TRIGGER_VARIABLE_LABEL_LENGTH,
    MAX_TRIGGER_VARIABLES,
    triggerVariablesProblem,
} from './inbound-trigger-form.shared';

describe('triggerVariablesProblem — TriggerVariableDto / defaultVariables rules', () => {
    it('accepts keys of letters, digits, _ and -', () => {
        expect(
            triggerVariablesProblem([{ key: 'repo' }, { key: 'pr_number' }, { key: 'x-1' }]),
        ).toBeNull();
        expect(triggerVariablesProblem([])).toBeNull();
    });

    it('names a key given twice (after trimming, case-sensitively), as the API refuses it', () => {
        expect(
            triggerVariablesProblem([
                { key: 'repo' },
                { key: 'branch' },
                { key: ' repo ' },
                { key: 'Branch' },
            ]),
        ).toEqual({ reason: 'variablesDuplicateKey', keys: 'repo' });
    });

    it('names every key with a dot, a space or past 64 characters', () => {
        expect(
            triggerVariablesProblem([
                { key: 'ok' },
                { key: 'repo.name' },
                { key: 'pull request' },
                { key: 'k'.repeat(65) },
            ]),
        ).toEqual({
            reason: 'variablesInvalidKey',
            keys: `repo.name, pull request, ${'k'.repeat(65)}`,
        });
    });

    it('names the keys whose label is too long', () => {
        expect(
            triggerVariablesProblem([
                { key: 'a', label: 'x'.repeat(MAX_TRIGGER_VARIABLE_LABEL_LENGTH) },
                { key: 'b', label: 'x'.repeat(MAX_TRIGGER_VARIABLE_LABEL_LENGTH + 1) },
            ]),
        ).toEqual({ reason: 'variablesLabelTooLong', keys: 'b', max: 80 });
    });

    it('refuses more variables than the API takes', () => {
        const variables = Array.from({ length: MAX_TRIGGER_VARIABLES + 1 }, (_, i) => ({
            key: `k${i}`,
        }));
        expect(triggerVariablesProblem(variables)).toEqual({
            reason: 'variablesTooMany',
            max: 20,
        });
        expect(triggerVariablesProblem(variables.slice(1))).toBeNull();
    });
});

describe('isValidTriggerReplayWindow — @IsInt() @Min(10) @Max(86400)', () => {
    it.each([10, 300, 86400])('accepts %d', (seconds) => {
        expect(isValidTriggerReplayWindow(seconds)).toBe(true);
    });

    it.each([9, 5, 0, -10, 86401, 12.5, Number.NaN])('refuses %d', (seconds) => {
        expect(isValidTriggerReplayWindow(seconds)).toBe(false);
    });
});
