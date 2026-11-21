import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Payload of `POST /api/auth/demo`. */
export class CreateDemoSandboxDto {
    @ApiPropertyOptional({
        description:
            'Captcha token from the configured provider (required when a captcha provider is configured)',
    })
    @IsOptional()
    @IsString()
    @MaxLength(4096)
    captchaToken?: string;
}
