import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Request,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { config } from '@ever-works/agent/config';
import { Public } from '../auth/decorators/public.decorator';
import { CaptchaVerifierService } from '../auth/services/captcha-verifier.service';
import { trustedClientIp } from '../config/trust-proxy';
import { CreateDemoSandboxDto } from './dto/create-demo-sandbox.dto';
import { DemoSandboxService } from './demo-sandbox.service';

/** `POST /api/auth/demo` — exists only when `DemoModule` is registered with `DEMO` on (404 otherwise). */
@ApiTags('auth')
@Controller('api/auth')
export class DemoController {
    constructor(
        private readonly sandboxService: DemoSandboxService,
        private readonly captchaVerifier: CaptchaVerifierService,
    ) {}

    @Public()
    @Post('demo')
    // The named `long` throttler (the only tier the guard honours); per IP for anonymous callers.
    @Throttle({ long: { limit: config.demo.createPerIpPerHour(), ttl: 3_600_000 } })
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Start a demo sandbox (one-click demo account with a 24 h session)' })
    @ApiResponse({ status: 201, description: 'Demo session issued' })
    @ApiResponse({ status: 400, description: 'Captcha verification failed' })
    @ApiResponse({ status: 429, description: 'Rate limit exceeded for this IP' })
    @ApiResponse({ status: 503, description: 'DEMO_FULL: the demo has no free sandbox' })
    async create(@Request() req, @Body() body?: CreateDemoSandboxDto) {
        // The address the `long` throttler counted (Express `trust proxy`), never the
        // client-written left-most `X-Forwarded-For` entry.
        const ipAddress = trustedClientIp(req);
        const userAgent =
            typeof req.headers?.['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;

        if (this.captchaVerifier.isEnabled()) {
            const result = await this.captchaVerifier.verify({
                token: body?.captchaToken,
                remoteIp: ipAddress,
            });
            if (!result.success) {
                throw new BadRequestException('captcha verification failed');
            }
        }

        return await this.sandboxService.createSandbox({ ipAddress, userAgent });
    }
}
