import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TriggerVariableDto } from './inbound-trigger.dto';

/**
 * `TriggerVariableDto` trims `key` and `label` BEFORE validating them, so the
 * DTO, `normalizeDefaultVariables` (which stores them trimmed) and the web
 * trigger form all judge the same text. Before, the DTO measured the raw
 * string: a padded 80-character label, or a key with surrounding spaces, was
 * refused here although the service and the form accept it.
 */
async function check(input: Record<string, unknown>) {
    const dto = plainToInstance(TriggerVariableDto, input);
    const errors = await validate(dto);
    return { dto, constraints: errors.flatMap((e) => Object.keys(e.constraints ?? {})) };
}

describe('TriggerVariableDto — key and label are trimmed before validation', () => {
    it('accepts a padded key and stores it trimmed', async () => {
        const { dto, constraints } = await check({ key: '  repo  ' });
        expect(constraints).toEqual([]);
        expect(dto.key).toBe('repo');
    });

    it('measures an 80-character label without its padding', async () => {
        const { dto, constraints } = await check({ key: 'repo', label: `  ${'l'.repeat(80)}  ` });
        expect(constraints).toEqual([]);
        expect(dto.label).toBe('l'.repeat(80));
    });

    it('still refuses a label over 80 characters once trimmed', async () => {
        const { constraints } = await check({ key: 'repo', label: ` ${'l'.repeat(81)} ` });
        expect(constraints).toContain('maxLength');
    });

    it('still refuses a key with a dot or an inner space', async () => {
        expect((await check({ key: 'repo.name' })).constraints).toContain('matches');
        expect((await check({ key: 'pull request' })).constraints).toContain('matches');
    });
});
