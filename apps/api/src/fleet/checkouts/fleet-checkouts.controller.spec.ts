import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { CreateFleetCheckoutDto } from './dto/fleet-checkout.dto';
import { FleetCheckoutsController } from './fleet-checkouts.controller';

/**
 * FL-14 FR-16 — `POST /api/fleet/checkouts` with `"branch": null` (and
 * `"baseRef": null`): MCP tools and generated clients send null for an unset
 * optional field. null is the same as leaving the field out, so a clone with
 * no branch named stays on what it cloned instead of being refused "branch".
 */

const USER = '11111111-1111-4111-8111-111111111111';
const NODE = '44444444-4444-4444-8444-444444444444';
const auth = { userId: USER } as AuthenticatedUser;

const errorsFor = (body: Record<string, unknown>) =>
    validate(plainToInstance(CreateFleetCheckoutDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
    });

describe('FleetCheckoutsController.create — null is the same as absent', () => {
    const clone = { kind: 'clone' as const, repoUrl: 'https://github.com/acme/api.git' };

    it('accepts `branch: null` and `baseRef: null` in the body', async () => {
        expect(
            await errorsFor({ nodeId: NODE, source: clone, branch: null, baseRef: null }),
        ).toHaveLength(0);
    });

    it('asks the service with no branch and no baseRef when the body sends null', async () => {
        const create = jest.fn(async () => ({ checkout: {}, operationId: null }));
        const controller = new FleetCheckoutsController({ create } as never);

        await controller.create(
            auth,
            plainToInstance(CreateFleetCheckoutDto, {
                nodeId: NODE,
                source: clone,
                branch: null,
                baseRef: null,
            }),
        );

        expect(create).toHaveBeenCalledTimes(1);
        const request = (create.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
        expect(request).toEqual({ nodeId: NODE, source: clone });
        expect(request).not.toHaveProperty('branch');
        expect(request).not.toHaveProperty('baseRef');
    });

    it('passes a named branch and base ref through', async () => {
        const create = jest.fn(async () => ({ checkout: {}, operationId: null }));
        const controller = new FleetCheckoutsController({ create } as never);

        await controller.create(
            auth,
            plainToInstance(CreateFleetCheckoutDto, {
                nodeId: NODE,
                source: clone,
                branch: 'nina/fix-login',
                baseRef: 'release',
            }),
        );

        expect((create.mock.calls[0] as unknown[])[1]).toEqual({
            nodeId: NODE,
            source: clone,
            branch: 'nina/fix-login',
            baseRef: 'release',
        });
    });
});
