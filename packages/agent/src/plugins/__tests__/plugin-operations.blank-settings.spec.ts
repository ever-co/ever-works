import { BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Repository } from 'typeorm';
import type { JsonSchema } from '@ever-works/plugin';
import { PluginOperationsService } from '../services/plugin-operations.service';
import { PluginSettingsService } from '../services/plugin-settings.service';
import { SettingsSchemaValidatorService } from '../services/settings-schema-validator.service';
import type { PluginRegistryService } from '../services/plugin-registry.service';
import type { PluginEntity } from '../entities/plugin.entity';
import type { UserPluginEntity } from '../entities/user-plugin.entity';
import type { WorkPluginEntity } from '../entities/work-plugin.entity';
import type { PluginRepository } from '../repositories/plugin.repository';
import type { UserPluginRepository } from '../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../repositories/work-plugin.repository';
import type { WorkOwnershipService } from '../../services/work-ownership.service';
import { createRegistry, registerColdPlugin } from './cold-plugin.fixture';

// Same isolation as plugin-operations.service.spec.ts: the facades barrel
// pulls in the whole agent graph.
jest.mock('../../facades', () => ({
    AiFacadeService: class AiFacadeService {},
}));

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * The shapes of the plugin fields a user clears in the settings form:
 * github-actions-build `largerRunnerLabel` (pattern, "Leave blank to use the
 * standard runner") and posthog-metrics `apiHost` (`format: uri`), next to an
 * optional number and an optional enum, where `''` is a wrong value.
 */
const SCHEMA: JsonSchema = {
    type: 'object',
    required: ['projectId'],
    properties: {
        projectId: { type: 'string', pattern: '^[0-9]+$' },
        largerRunnerLabel: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
        apiHost: { type: 'string', format: 'uri' },
        retries: { type: 'number', minimum: 0 },
        region: { type: 'string', enum: ['eu', 'us'] },
    },
} as unknown as JsonSchema;

const PLUGIN_ID = 'blank-settings';

/** The `Invalid plugin settings` 400 — not any other 400 the save can give. */
async function validationRefusal(promise: Promise<unknown>): Promise<unknown> {
    const error = await promise.then(
        () => {
            throw new Error('expected the save to be refused');
        },
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
}

/**
 * `PluginOperationsService.updateUserPluginSettings` / `enablePluginForUser`
 * over the REAL schema validator: the empty-value rule must hold where the
 * API applies it, not only in the helper (resetting the service to call the
 * validator on the raw settings fails these).
 */
describe('PluginOperationsService — blank optional settings', () => {
    let registry: PluginRegistryService;
    let service: PluginOperationsService;
    let userPluginRepository: {
        find: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let workPluginRepository: {
        find: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };

    beforeEach(() => {
        registry = createRegistry();
        registerColdPlugin(registry, { id: PLUGIN_ID, settingsSchema: SCHEMA });
        const pluginRepository = {
            findOne: jest.fn(async ({ where }: { where: { pluginId: string } }) => ({
                id: `entity-${where.pluginId}`,
                pluginId: where.pluginId,
            })),
        };
        userPluginRepository = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue({
                userId: 'user-1',
                pluginId: PLUGIN_ID,
                pluginEntityId: `entity-${PLUGIN_ID}`,
                enabled: true,
                settings: {
                    projectId: '1',
                    largerRunnerLabel: 'big-runner',
                    apiHost: 'https://eu.posthog.com',
                },
                secretSettings: {},
                metadata: {},
            }),
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        workPluginRepository = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const settingsService = new PluginSettingsService(
            registry,
            { findByPluginId: jest.fn().mockResolvedValue(null) } as unknown as PluginRepository,
            {
                findByUserAndPlugin: jest.fn().mockResolvedValue(null),
            } as unknown as UserPluginRepository,
            {
                findByWorkAndPlugin: jest.fn().mockResolvedValue(null),
            } as unknown as WorkPluginRepository,
            new EventEmitter2(),
        );
        service = new PluginOperationsService(
            pluginRepository as unknown as Repository<PluginEntity>,
            userPluginRepository as unknown as Repository<UserPluginEntity>,
            workPluginRepository as unknown as Repository<WorkPluginEntity>,
            registry,
            new SettingsSchemaValidatorService(),
            settingsService,
            {} as never,
            new EventEmitter2(),
            undefined,
            {
                ensureCanEdit: jest.fn().mockResolvedValue(undefined),
                ensureCanView: jest.fn().mockResolvedValue(undefined),
            } as unknown as WorkOwnershipService,
        );
    });

    it('saves a cleared optional text field that has a pattern or a format, stored as blank', async () => {
        await expect(
            service.updateUserPluginSettings(PLUGIN_ID, 'user-1', {
                largerRunnerLabel: '',
                apiHost: '',
            }),
        ).resolves.toBeDefined();

        const saved = userPluginRepository.save.mock.calls.at(-1)?.[0] as {
            settings: Record<string, unknown>;
        };
        expect(saved.settings).toMatchObject({ largerRunnerLabel: '', apiHost: '' });
    });

    it('enables the plugin with a cleared optional text field', async () => {
        userPluginRepository.findOne.mockResolvedValue(null);

        await expect(
            service.enablePluginForUser(PLUGIN_ID, 'user-1', { projectId: '1', apiHost: '' }),
        ).resolves.toBeDefined();
    });

    it('saves a cleared optional text field at Work scope (enable and update)', async () => {
        await expect(
            service.enablePluginForWork('work-1', PLUGIN_ID, 'user-1', {
                settings: { largerRunnerLabel: '' },
            }),
        ).resolves.toBeDefined();

        workPluginRepository.findOne.mockResolvedValue(enabledWorkPlugin());
        await expect(
            service.updateWorkPluginSettings('work-1', PLUGIN_ID, 'user-1', { apiHost: '' }),
        ).resolves.toBeDefined();
    });

    it('still refuses a blank REQUIRED field', async () => {
        await expect(
            validationRefusal(
                service.updateUserPluginSettings(PLUGIN_ID, 'user-1', { projectId: '' }),
            ),
        ).resolves.toMatchObject({ message: 'Invalid plugin settings' });

        workPluginRepository.findOne.mockResolvedValue(enabledWorkPlugin());
        await expect(
            validationRefusal(
                service.updateWorkPluginSettings('work-1', PLUGIN_ID, 'user-1', { projectId: '' }),
            ),
        ).resolves.toMatchObject({ message: 'Invalid plugin settings' });
    });

    it.each([
        ['an optional number', { retries: '' }],
        ['an optional enum', { region: '' }],
    ])('refuses a blank value in %s', async (_label, settings) => {
        await expect(
            validationRefusal(service.updateUserPluginSettings(PLUGIN_ID, 'user-1', settings)),
        ).resolves.toMatchObject({ message: 'Invalid plugin settings' });
        expect(userPluginRepository.save).not.toHaveBeenCalled();
    });

    it('still refuses a non-empty invalid text value', async () => {
        await expect(
            validationRefusal(
                service.updateUserPluginSettings(PLUGIN_ID, 'user-1', { apiHost: 'not a url' }),
            ),
        ).resolves.toMatchObject({ message: 'Invalid plugin settings' });
    });

    function enabledWorkPlugin() {
        return {
            workId: 'work-1',
            pluginId: PLUGIN_ID,
            pluginEntityId: `entity-${PLUGIN_ID}`,
            enabled: true,
            settings: {},
            secretSettings: {},
            metadata: {},
        };
    }
});
