import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FLEET_MAX_NODE_NAME_LENGTH } from '@ever-works/contracts';
import { FleetCloudDestroyDto } from './fleet-cloud.dto';

const errorsFor = (body: Record<string, unknown>) =>
    validate(plainToInstance(FleetCloudDestroyDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
    });

describe('FleetCloudDestroyDto.confirmName', () => {
    it('accepts the name of a computer renamed past the 39-character create rule', async () => {
        // Rename allows up to FLEET_MAX_NODE_NAME_LENGTH; the confirmation was
        // capped at 39, so such a computer could never be destroyed.
        expect(await errorsFor({ confirmName: 'a'.repeat(60) })).toHaveLength(0);
        expect(
            await errorsFor({ confirmName: 'a'.repeat(FLEET_MAX_NODE_NAME_LENGTH) }),
        ).toHaveLength(0);
    });

    it('still refuses a name longer than any node name can be', async () => {
        expect(
            await errorsFor({ confirmName: 'a'.repeat(FLEET_MAX_NODE_NAME_LENGTH + 1) }),
        ).not.toHaveLength(0);
    });

    it('stays optional (the first call answers confirmation_required)', async () => {
        expect(await errorsFor({})).toHaveLength(0);
    });
});
