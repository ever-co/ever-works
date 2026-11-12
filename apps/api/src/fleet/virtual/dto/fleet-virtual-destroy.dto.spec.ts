import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FLEET_MAX_NODE_NAME_LENGTH } from '@ever-works/contracts';
import { FleetVirtualDestroyDto } from './fleet-virtual.dto';

const errorsFor = (body: Record<string, unknown>) =>
    validate(plainToInstance(FleetVirtualDestroyDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
    });

describe('FleetVirtualDestroyDto.confirmName', () => {
    it('accepts the name of a virtual computer renamed past 64 characters', async () => {
        // Rename allows up to FLEET_MAX_NODE_NAME_LENGTH for any node, a VM or
        // container child included; the confirmation was capped at 64, so
        // such a virtual computer could never be destroyed.
        expect(await errorsFor({ confirmName: 'a'.repeat(70) })).toHaveLength(0);
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
