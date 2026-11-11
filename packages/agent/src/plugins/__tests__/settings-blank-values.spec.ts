import type { JsonSchema } from '@ever-works/plugin';
import { SettingsSchemaValidatorService } from '../services/settings-schema-validator.service';
import { withoutBlankOptionalValues } from '../services/settings-blank-values';

/**
 * The shapes of the two plugin fields that made a user-scope save fail when
 * cleared: github-actions-build `largerRunnerLabel` (pattern, "Leave blank to use
 * the standard runner") and posthog-metrics `apiHost` (`format: uri`).
 */
const schema: JsonSchema = {
    type: 'object',
    required: ['projectId'],
    properties: {
        projectId: { type: 'string', pattern: '^[0-9]+$' },
        largerRunnerLabel: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
        apiHost: { type: 'string', format: 'uri' },
    },
} as JsonSchema;

describe('withoutBlankOptionalValues + the real settings validator', () => {
    const validator = new SettingsSchemaValidatorService();
    const validate = (settings: Record<string, unknown>) =>
        validator.validate(withoutBlankOptionalValues(settings, schema), schema, 'user');

    it('accepts a cleared optional field that has a pattern or a format', () => {
        // Raw, these fail: '' does not match the pattern, and '' is not a URI.
        expect(
            validator.validate({ projectId: '1', largerRunnerLabel: '' }, schema, 'user').valid,
        ).toBe(false);
        expect(validator.validate({ projectId: '1', apiHost: '' }, schema, 'user').valid).toBe(
            false,
        );

        expect(validate({ projectId: '1', largerRunnerLabel: '', apiHost: '' }).valid).toBe(true);
    });

    it('still refuses a non-empty invalid value', () => {
        expect(validate({ projectId: '1', largerRunnerLabel: 'has spaces' }).valid).toBe(false);
        expect(validate({ projectId: '1', apiHost: 'not a url' }).valid).toBe(false);
    });

    it('still validates a blank REQUIRED field', () => {
        expect(validate({ projectId: '' }).valid).toBe(false);
    });

    it('keeps every other value for the check, including false and 0', () => {
        expect(
            withoutBlankOptionalValues({ a: '', b: false, c: 0, d: 'x', projectId: '' }, schema),
        ).toEqual({
            b: false,
            c: 0,
            d: 'x',
            projectId: '',
        });
    });
});
