import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Put,
    UseGuards,
    HttpCode,
    HttpStatus,
    ParseEnumPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
} from 'class-validator';
import { IsIanaTimeZone } from '../common/is-iana-time-zone';
import { CurrentUser, AuthSessionGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationCategory } from '@ever-works/agent/entities';

// Security: HH:mm (optionally with :ss) — rejects arbitrary strings stored as
// quiet-hours times. Seconds are optional because callers commonly send the
// full `HH:mm:ss` TIME form; both are accepted and stored verbatim.
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const NOTIFICATION_CATEGORY_VALUES = Object.values(NotificationCategory);

export class QuietHoursBody {
    // Security: must match HH:mm to prevent arbitrary strings in DB
    @IsOptional()
    @IsString()
    @Matches(HH_MM_PATTERN, { message: 'quietHoursStart must be in HH:mm format' })
    quietHoursStart?: string | null;

    // Security: must match HH:mm to prevent arbitrary strings in DB
    @IsOptional()
    @IsString()
    @Matches(HH_MM_PATTERN, { message: 'quietHoursEnd must be in HH:mm format' })
    quietHoursEnd?: string | null;

    // Security: must be a valid IANA timezone to prevent RangeError in Intl.DateTimeFormat downstream
    @IsOptional()
    @IsString()
    @IsIanaTimeZone()
    timezone?: string | null;

    // AW-13: the person's opt-in to let every urgent event through quiet
    // hours. Optional; when omitted the stored value is kept.
    @IsOptional()
    @IsBoolean()
    urgentBypassesQuietHours?: boolean;
}

/**
 * `PUT preferences/event/:eventKey` — the channels one event type is delivered
 * to (`[]` mutes it). A class, not an inline type: with `{ channelIds }` typed
 * inline the global ValidationPipe validated nothing, so a body without
 * `channelIds` (the chat tool's old hint sent `enabled` / `channels`) reached
 * the service as `undefined` and saved an EMPTY selection — silently muting
 * the event. Now such a body is a 400.
 */
export class SetEventSubscriptionBody {
    @ApiProperty({ type: [String], description: 'Notification channel ids; [] mutes the event.' })
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @MaxLength(128, { each: true })
    channelIds: string[];
}

class MuteBody {
    // Security: restrict category to the known NotificationCategory enum values.
    // Keep Swagger on a plain values array; reflecting the enum object here can
    // trigger a circular schema error on enum keys such as AI_CREDITS.
    @ApiProperty({
        enum: NOTIFICATION_CATEGORY_VALUES,
        description: 'Notification category to mute.',
    })
    @IsEnum(NotificationCategory, {
        message: `category must be one of: ${NOTIFICATION_CATEGORY_VALUES.join(', ')}`,
    })
    category: NotificationCategory;

    @IsOptional()
    @IsString()
    mutedUntil?: string | null;
}

/**
 * EW-664 / EW-678 — User notification preferences REST API.
 */
@ApiTags('Notification Preferences')
@ApiBearerAuth('JWT-auth')
@Controller('api/notifications')
@UseGuards(AuthSessionGuard)
export class NotificationPreferencesController {
    constructor(private readonly service: NotificationPreferencesService) {}

    @Get('event-types')
    @ApiOperation({ summary: 'List all registered notification event types' })
    async listEventTypes() {
        const eventTypes = await this.service.listEventTypes();
        return { eventTypes };
    }

    @Get('preferences')
    @ApiOperation({
        summary: 'Get my notification preferences (subscriptions + quiet hours + mutes)',
    })
    async getPreferences(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getPreferences(auth.userId);
    }

    @Put('preferences/event/:eventKey')
    @ApiOperation({ summary: 'Set channel selection for one event type' })
    async setEventSubscription(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('eventKey') eventKey: string,
        @Body() body: SetEventSubscriptionBody,
    ) {
        const subscription = await this.service.setEventSubscription(
            auth.userId,
            eventKey,
            body.channelIds,
        );
        return { subscription };
    }

    @Put('preferences/quiet-hours')
    @ApiOperation({ summary: 'Set quiet hours window + timezone' })
    async setQuietHours(@CurrentUser() auth: AuthenticatedUser, @Body() body: QuietHoursBody) {
        const start = body.quietHoursStart ?? null;
        const end = body.quietHoursEnd ?? null;
        const timezone = body.timezone ?? null;
        const preference =
            typeof body.urgentBypassesQuietHours === 'boolean'
                ? await this.service.setQuietHours(
                      auth.userId,
                      start,
                      end,
                      timezone,
                      body.urgentBypassesQuietHours,
                  )
                : await this.service.setQuietHours(auth.userId, start, end, timezone);
        return { preference };
    }

    @Post('preferences/mute')
    @ApiOperation({ summary: 'Mute a category until a given time (or indefinitely)' })
    async muteCategory(@CurrentUser() auth: AuthenticatedUser, @Body() body: MuteBody) {
        const mutedUntil = body.mutedUntil ? new Date(body.mutedUntil) : null;
        // Security: body.category is now validated as NotificationCategory by class-validator
        const mute = await this.service.muteCategory(auth.userId, body.category, mutedUntil);
        return { mute };
    }

    @Delete('preferences/mute/:category')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Unmute a category' })
    // Keep Swagger on a plain values array for the same reason as MuteBody.
    // Runtime validation is still enforced by the ParseEnumPipe below.
    @ApiParam({
        name: 'category',
        type: String,
        enum: NOTIFICATION_CATEGORY_VALUES,
        description: 'Notification category to unmute.',
    })
    async unmuteCategory(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: ParseEnumPipe rejects path params not in NotificationCategory
        @Param('category', new ParseEnumPipe(NotificationCategory)) category: NotificationCategory,
    ) {
        await this.service.unmuteCategory(auth.userId, category);
    }
}
