// The real seeder pulls the whole agent graph (and better-auth's ESM); this spec hands the
// controller a sandbox double and never reaches it.
jest.mock('../seed/demo-sandbox-seeder.service', () => ({
    DemoSandboxSeederService: class DemoSandboxSeederService {},
}));

import { BadRequestException } from '@nestjs/common';
import { DemoController } from '../demo.controller';

describe('DemoController', () => {
    const req = { ip: '9.9.9.9', headers: { 'user-agent': 'jest' } };
    let sandbox: { createSandbox: jest.Mock };
    let captcha: { isEnabled: jest.Mock; verify: jest.Mock };
    let controller: DemoController;

    beforeEach(() => {
        sandbox = { createSandbox: jest.fn().mockResolvedValue({ access_token: 't' }) };
        captcha = { isEnabled: jest.fn().mockReturnValue(false), verify: jest.fn() };
        controller = new DemoController(sandbox as never, captcha as never);
    });

    it('creates a sandbox with the request ip and user agent', async () => {
        await expect(controller.create(req, {})).resolves.toEqual({ access_token: 't' });
        expect(sandbox.createSandbox).toHaveBeenCalledWith({
            ipAddress: '9.9.9.9',
            userAgent: 'jest',
        });
        expect(captcha.verify).not.toHaveBeenCalled();
    });

    it('rejects a failed captcha with 400 and creates nothing', async () => {
        captcha.isEnabled.mockReturnValue(true);
        captcha.verify.mockResolvedValue({ success: false });
        await expect(controller.create(req, { captchaToken: 'bad' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(captcha.verify).toHaveBeenCalledWith({ token: 'bad', remoteIp: '9.9.9.9' });
        expect(sandbox.createSandbox).not.toHaveBeenCalled();
    });

    /**
     * The address comes from Express (`req.ip`, resolved through `trust proxy` /
     * `TRUST_PROXY_HOPS` from the right of the chain), never from the left-most
     * `X-Forwarded-For` entry, which the client writes. It is the address the `long`
     * throttler keys on, so the captcha and the session record the caller the limit counted.
     */
    describe('client address', () => {
        beforeEach(() => {
            captcha.isEnabled.mockReturnValue(true);
            captcha.verify.mockResolvedValue({ success: true });
        });

        it('takes req.ip, not the client-written first X-Forwarded-For entry', async () => {
            const proxied = {
                ip: '203.0.113.7',
                headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7', 'user-agent': 'jest' },
            };

            await controller.create(proxied, { captchaToken: 'ok' });

            expect(captcha.verify).toHaveBeenCalledWith({ token: 'ok', remoteIp: '203.0.113.7' });
            expect(sandbox.createSandbox).toHaveBeenCalledWith({
                ipAddress: '203.0.113.7',
                userAgent: 'jest',
            });
        });

        it('falls back to the socket address, never to X-Forwarded-For, when req.ip is unset', async () => {
            const bare = {
                socket: { remoteAddress: '10.0.0.9' },
                headers: { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'jest' },
            };

            await controller.create(bare, { captchaToken: 'ok' });

            expect(captcha.verify).toHaveBeenCalledWith({ token: 'ok', remoteIp: '10.0.0.9' });
            expect(sandbox.createSandbox).toHaveBeenCalledWith({
                ipAddress: '10.0.0.9',
                userAgent: 'jest',
            });
        });

        it('records no address rather than a forged one', async () => {
            await controller.create({ headers: { 'x-forwarded-for': '6.6.6.6' } }, {});

            expect(captcha.verify).toHaveBeenCalledWith({ token: undefined, remoteIp: null });
            expect(sandbox.createSandbox).toHaveBeenCalledWith({
                ipAddress: null,
                userAgent: null,
            });
        });
    });

    it('is POST /api/auth/demo, public, and throttled on the long tier', () => {
        expect(Reflect.getMetadata('path', DemoController)).toBe('api/auth');
        expect(Reflect.getMetadata('path', DemoController.prototype.create)).toBe('demo');
        expect(Reflect.getMetadata('THROTTLER:LIMITlong', DemoController.prototype.create)).toBe(5);
        expect(Reflect.getMetadata('THROTTLER:TTLlong', DemoController.prototype.create)).toBe(
            3_600_000,
        );
    });
});
