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
        expect(sandbox.createSandbox).toHaveBeenCalledWith({ ipAddress: '9.9.9.9', userAgent: 'jest' });
        expect(captcha.verify).not.toHaveBeenCalled();
    });

    it('rejects a failed captcha with 400 and creates nothing', async () => {
        captcha.isEnabled.mockReturnValue(true);
        captcha.verify.mockResolvedValue({ success: false });
        await expect(controller.create(req, { captchaToken: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
        expect(captcha.verify).toHaveBeenCalledWith({ token: 'bad', remoteIp: '9.9.9.9' });
        expect(sandbox.createSandbox).not.toHaveBeenCalled();
    });

    it('is POST /api/auth/demo, public, and throttled on the long tier', () => {
        expect(Reflect.getMetadata('path', DemoController)).toBe('api/auth');
        expect(Reflect.getMetadata('path', DemoController.prototype.create)).toBe('demo');
        expect(Reflect.getMetadata('THROTTLER:LIMITlong', DemoController.prototype.create)).toBe(5);
        expect(Reflect.getMetadata('THROTTLER:TTLlong', DemoController.prototype.create)).toBe(3_600_000);
    });
});
