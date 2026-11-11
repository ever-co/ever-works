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
        if (value === '' && !required.has(key)) {
            continue;
        }
        out[key] = value;
    }
    return out;
}
