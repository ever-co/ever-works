import type { JsonSchema } from '@ever-works/plugin';

/**
 * The settings a plugin-settings save VALIDATES against the plugin's schema:
 * everything except an empty string in an OPTIONAL field.
 *
 * At user scope the settings form keeps a cleared field as `''` on purpose
 * (`sanitizeSettingsForSave`: "a user can intentionally save a blank value"),
 * and that is what gets stored. But the schema check ran on the raw value, so
 * clearing any optional field that carries a `pattern` or a `format` failed
 * the whole save with "Invalid plugin settings" — e.g. github-actions-build's
 * `largerRunnerLabel` ("Leave blank to use the standard runner") or
 * posthog-metrics' `apiHost` (`format: uri`). An empty optional value now
 * means "not set" for the check only; a REQUIRED field left blank is still
 * validated as before.
 */
export function withoutBlankOptionalValues(
    settings: Record<string, unknown>,
    schema: JsonSchema | undefined,
): Record<string, unknown> {
    const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (value === '' && !required.has(key) && isFreeTextField(schema, key)) {
            continue;
        }
        out[key] = value;
    }
    return out;
}

/**
 * Only a free-text field can be "cleared" to `''`: a field typed `string`
 * without an `enum` / `const`. `''` in an optional number, boolean or enum
 * field (or in a key the schema does not declare) is a wrong value, not a
 * blank one, so it still goes to the validator and is refused.
 */
function isFreeTextField(schema: JsonSchema | undefined, key: string): boolean {
    const property = (schema?.properties as Record<string, Record<string, unknown>> | undefined)?.[
        key
    ];
    if (!property || typeof property !== 'object') {
        return false;
    }
    const type = property.type;
    const isString = type === 'string' || (Array.isArray(type) && type.includes('string'));
    return isString && property.enum === undefined && property.const === undefined;
}
