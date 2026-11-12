/**
 * The Task trigger form's limits — the rules of `CreateInboundTriggerDto` /
 * `UpdateInboundTriggerDto` (`apps/api/src/triggers/dto/inbound-trigger.dto.ts`,
 * constants in `packages/agent/src/triggers`). The form sent a variable key
 * such as `repo.name` or a replay window of 5, and the API's raw 400
 * ("defaultVariables key must be 1-64 chars of [A-Za-z0-9_-]") was the only
 * explanation. The form checks the same rules first and says which field is
 * wrong.
 */

/** `TriggerVariableDto.key`: 1-64 letters, digits, `_` or `-`. */
export const TRIGGER_VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** `MAX_VARIABLE_LABEL_LENGTH`. */
export const MAX_TRIGGER_VARIABLE_LABEL_LENGTH = 80;
/** `MAX_DEFAULT_VARIABLES` (`@ArrayMaxSize`). */
export const MAX_TRIGGER_VARIABLES = 20;
/** `MIN_REPLAY_WINDOW_SEC` / `MAX_REPLAY_WINDOW_SEC` (`@IsInt() @Min @Max`). */
export const MIN_TRIGGER_REPLAY_WINDOW_SEC = 10;
export const MAX_TRIGGER_REPLAY_WINDOW_SEC = 24 * 60 * 60;

export type TriggerVariablesProblem =
    | { reason: 'variablesInvalidKey'; keys: string }
    | { reason: 'variablesDuplicateKey'; keys: string }
    | { reason: 'variablesLabelTooLong'; keys: string; max: number }
    | { reason: 'variablesTooMany'; max: number };

/**
 * What the API would refuse in the parsed variable list, or `null`. Names the
 * offending keys so the message points at the lines to fix.
 */
export function triggerVariablesProblem(
    variables: ReadonlyArray<{ key: string; label?: string }>,
): TriggerVariablesProblem | null {
    const badKeys = variables
        // Trimmed first, as `normalizeDefaultVariables` does.
        .map((variable) => variable.key.trim())
        .filter((key) => !TRIGGER_VARIABLE_KEY_PATTERN.test(key));
    if (badKeys.length > 0) {
        return { reason: 'variablesInvalidKey', keys: badKeys.join(', ') };
    }
    // `normalizeDefaultVariables` (packages/agent/src/triggers/trigger-variables.ts)
    // refuses a key seen twice after trimming, case-sensitively.
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const variable of variables) {
        const key = variable.key.trim();
        if (seen.has(key)) duplicates.add(key);
        seen.add(key);
    }
    if (duplicates.size > 0) {
        return { reason: 'variablesDuplicateKey', keys: [...duplicates].join(', ') };
    }
    const longLabels = variables
        // Trimmed first, as the API measures it (`normalizeDefaultVariables`).
        .filter(
            (variable) => (variable.label?.trim().length ?? 0) > MAX_TRIGGER_VARIABLE_LABEL_LENGTH,
        )
        .map((variable) => variable.key);
    if (longLabels.length > 0) {
        return {
            reason: 'variablesLabelTooLong',
            keys: longLabels.join(', '),
            max: MAX_TRIGGER_VARIABLE_LABEL_LENGTH,
        };
    }
    if (variables.length > MAX_TRIGGER_VARIABLES) {
        return { reason: 'variablesTooMany', max: MAX_TRIGGER_VARIABLES };
    }
    return null;
}

/** Does the API take this replay window: a whole number of seconds from 10 to 86400? */
export function isValidTriggerReplayWindow(seconds: number): boolean {
    return (
        Number.isInteger(seconds) &&
        seconds >= MIN_TRIGGER_REPLAY_WINDOW_SEC &&
        seconds <= MAX_TRIGGER_REPLAY_WINDOW_SEC
    );
}
