jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));
jest.mock('./notification-preferences.service', () => ({
    NotificationPreferencesService: class {},
}));
jest.mock('@ever-works/agent/entities', () =>
    jest.requireActual('../../../../packages/agent/src/entities/notification.types'),
);

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
    NotificationPreferencesController,
    QuietHoursBody,
    SetEventSubscriptionBody,
} from './notification-preferences.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * AW-13 — the quiet-hours write carries the person's opt-in to let every
 * urgent event through. Callers that only know about the window (the chat
 * assistant, older clients) must never flip it.
 */
describe('NotificationPreferencesController — quiet hours', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;
    let service: { setQuietHours: jest.Mock };
    let controller: NotificationPreferencesController;

    beforeEach(() => {
        service = {
            setQuietHours: jest.fn().mockResolvedValue({ userId: 'user-1' }),
        };
        controller = new NotificationPreferencesController(service as never);
    });

    it('passes only the window when the opt-in is not named', async () => {
        await controller.setQuietHours(auth, {
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
        });
        expect(service.setQuietHours.mock.calls[0]).toEqual(['user-1', '22:00', '07:00', 'UTC']);

        await controller.setQuietHours(auth, {});
        expect(service.setQuietHours.mock.calls[1]).toEqual(['user-1', null, null, null]);
    });

    it('passes the opt-in when it is named, on or off', async () => {
        await controller.setQuietHours(auth, {
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
            urgentBypassesQuietHours: true,
        });
        expect(service.setQuietHours.mock.calls[0]).toEqual([
            'user-1',
            '22:00',
            '07:00',
            'UTC',
            true,
        ]);
        await controller.setQuietHours(auth, { urgentBypassesQuietHours: false });
        expect(service.setQuietHours.mock.calls[1]).toEqual(['user-1', null, null, null, false]);
    });

    describe('body validation', () => {
        async function errorsFor(body: unknown) {
            return validate(plainToInstance(QuietHoursBody, body));
        }

        it('accepts the opt-in as a boolean, or left out', async () => {
            expect(await errorsFor({})).toHaveLength(0);
            expect(await errorsFor({ urgentBypassesQuietHours: true })).toHaveLength(0);
            expect(
                await errorsFor({
                    quietHoursStart: '22:00',
                    quietHoursEnd: '07:00',
                    timezone: 'UTC',
                    urgentBypassesQuietHours: false,
                }),
            ).toHaveLength(0);
        });

        it('rejects a non-boolean opt-in', async () => {
            expect(await errorsFor({ urgentBypassesQuietHours: 'yes' })).not.toHaveLength(0);
            expect(await errorsFor({ urgentBypassesQuietHours: 1 })).not.toHaveLength(0);
        });

        it('still rejects a malformed window', async () => {
            expect(await errorsFor({ quietHoursStart: '25:00' })).not.toHaveLength(0);
            expect(await errorsFor({ timezone: 'Mars/Phobos' })).not.toHaveLength(0);
        });
    });
});

describe('SetEventSubscriptionBody (PUT preferences/event/:eventKey)', () => {
    const errorsFor = async (body: Record<string, unknown>) =>
        validate(plainToInstance(SetEventSubscriptionBody, body), {
            whitelist: true,
            forbidNonWhitelisted: true,
        });

    /**
     * The constraints that failed on `channelIds`. Asserting on the property
     * (not just "some error") keeps these tests honest: with the DTO class
     * gone, `validate()` still reports an error — "an unknown value was passed
     * to the validate function", on no property — so a bare non-empty check
     * passed with the fix reverted.
     */
    const channelIdsConstraints = async (body: Record<string, unknown>) =>
        Object.keys(
            (await errorsFor(body)).find((e) => e.property === 'channelIds')?.constraints ?? {},
        );

    it('accepts a channel selection, including [] (mute) and built-in channel ids', async () => {
        expect(await errorsFor({ channelIds: [] })).toHaveLength(0);
        expect(await errorsFor({ channelIds: ['in-app', 'email'] })).toHaveLength(0);
    });

    it('refuses a body without channelIds — it used to save an empty selection and mute the event', async () => {
        // The chat tool's old hint sent `{ enabled, channels }`; the inline type
        // validated nothing and `channelIds` reached the service as undefined.
        expect(await channelIdsConstraints({ enabled: true, channels: ['in-app'] })).toContain(
            'isArray',
        );
        expect(await channelIdsConstraints({})).toContain('isArray');
    });

    it('refuses non-string channel ids', async () => {
        expect(await channelIdsConstraints({ channelIds: [1, 2] })).toContain('isString');
    });

    it('is the type the route validates its body against', () => {
        // The global ValidationPipe reads the handler's reflected parameter
        // types; an inline `{ channelIds: string[] }` reflects as `Object` and
        // validates nothing.
        const paramTypes = Reflect.getMetadata(
            'design:paramtypes',
            NotificationPreferencesController.prototype,
            'setEventSubscription',
        ) as unknown[];
        expect(paramTypes[2]).toBe(SetEventSubscriptionBody);
    });
});
