import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Not, type Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import type { RequestBody } from '@ever-co/connect-sdk';
import {
    EverConnectInstallRequest,
    type EverConnectInstallReportState,
} from '@ever-works/agent/entities';
import {
    EVER_INSTALLS_INTEGRATION_KEY,
    installStatusReport,
    isInstallDetailToken,
} from '@ever-works/contracts';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { withInstallReportLink } from '../ever-connect-link-header';
import {
    EVER_CONNECT_PLATFORM,
    type EverConnectPlatform,
} from '../identity/ever-connect-identity.ports';
import { describeFailure, platformFailure } from '../identity/platform-answer';

/** How many owed reports one pass sends at most. */
const PASS_SIZE = 50;
/** The waits before the next attempt of a report that could not be sent (then the last one). */
const RETRY_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

/**
 * Whether the pinned SDK takes `version` in an install status report. It does
 * not (its `InstallStatus` has `state`, `detail` and `external_ref`), so the
 * installed version is not sent yet; `external_ref` carries the plugin id. When
 * a newer SDK adds the field, this line stops compiling until it is set to
 * `true`.
 */
type SdkTakesVersion = 'version' extends keyof RequestBody<'instanceReportInstallStatus'>
    ? true
    : false;
const SDK_TAKES_VERSION: SdkTakesVersion = false;

/** What became of one attempt. */
export type InstallReportOutcome = 'sent' | 'retry' | 'dropped' | 'nothing_owed';

/**
 * Reports what this installation did with an install request to Ever Platform
 * (`POST /v1/installs/{install}/status`, under `marketplace_installs`, for the
 * request's tenant link): `installing`, `installed`, `failed` with a fixed
 * detail token, or `removed`.
 *
 * - A transition writes the report owed ({@link owe}) and tries it at once;
 *   one that could not be sent is tried again by the Ever Connect worker
 *   ({@link sendDue}) until Ever Platform records it. `installed` is preceded
 *   by `installing` when Ever Platform has not recorded that yet.
 * - Reporting the same state again changes nothing on Ever Platform; the
 *   `Idempotency-Key` is derived from the install and the state.
 * - Nothing is sent unless `marketplace_installs` is enabled for the request's
 *   tenant link: an owed report is dropped (logged), never sent later.
 * - Ever Platform refusing a report for good (`403`, `404`, `409`, `422`)
 *   drops it, logged; it is not retried.
 * - Ids and fixed tokens only: never a package URL, a token or free text.
 */
@Injectable()
export class InstallStatusReporter {
    private readonly logger = new Logger(InstallStatusReporter.name);

    constructor(
        @InjectRepository(EverConnectInstallRequest)
        private readonly requests: Repository<EverConnectInstallRequest>,
        @Inject(EVER_CONNECT_PLATFORM) private readonly platform: EverConnectPlatform,
        private readonly integrations: EverConnectIntegrationService,
    ) {}

    /** Owe `state` for the request and try to send it now. */
    async owe(
        installId: string,
        state: EverConnectInstallReportState,
    ): Promise<InstallReportOutcome> {
        await this.requests.update(
            { installId },
            { reportState: state, reportAttempts: 0, nextReportAt: new Date() },
        );
        const row = await this.requests.findOne({ where: { installId } });
        return row ? this.send(row) : 'nothing_owed';
    }

    /** Send the reports whose next attempt is due (the worker's pass). Answers how many were sent. */
    async sendDue(now = new Date()): Promise<number> {
        const rows = await this.requests.find({
            where: { reportState: Not(IsNull()), nextReportAt: LessThanOrEqual(now) },
            order: { nextReportAt: 'ASC' },
            take: PASS_SIZE,
        });
        let sent = 0;
        for (const row of rows) {
            if ((await this.send(row, now)) === 'sent') sent += 1;
        }
        return sent;
    }

    /**
     * `marketplace_installs` went off: every report still owed is dropped, so
     * nothing is sent after it (or after it comes back).
     */
    async dropOwed(reason: string): Promise<number> {
        const owed = await this.requests.find({ where: { reportState: Not(IsNull()) } });
        for (const row of owed) this.dropped(row, reason);
        if (owed.length > 0) {
            await this.requests.update(
                { reportState: Not(IsNull()) },
                { reportState: null, nextReportAt: null },
            );
        }
        return owed.length;
    }

    private async send(
        row: EverConnectInstallRequest,
        now = new Date(),
    ): Promise<InstallReportOutcome> {
        const target = row.reportState;
        if (!target || target === row.reportedState) {
            if (target) await this.settle(row);
            return 'nothing_owed';
        }
        if (!(await this.linkEnabled(row.linkId))) {
            this.dropped(row, 'integration_not_enabled');
            await this.settle(row);
            return 'dropped';
        }
        const client = await this.platform.client();
        if (!client) return this.retry(row, now, 'not_connected');

        // `installed` goes after `installing`, which Ever Platform may not have yet.
        let reported = row.reportedState;
        const steps: EverConnectInstallReportState[] =
            target === 'installed' && reported !== 'installing'
                ? ['installing', 'installed']
                : [target];
        for (const state of steps) {
            const body = installStatusReport({
                state,
                detail: isInstallDetailToken(row.detail) ? row.detail : null,
                version: SDK_TAKES_VERSION ? row.installedVersion : null,
                externalRef: state === 'installed' ? row.pluginId : null,
            });
            try {
                await withInstallReportLink(row.linkId as string, () =>
                    client.call('instanceReportInstallStatus', {
                        path: { install: row.installId },
                        body: body as RequestBody<'instanceReportInstallStatus'>,
                        idempotencyKey: idempotencyKey(row.installId, state),
                    }),
                );
            } catch (error) {
                const failure = platformFailure(error);
                if (
                    failure.kind === 'refused' ||
                    (failure.kind === 'problem' && [403, 404, 409, 422].includes(failure.status))
                ) {
                    this.logger.warn(
                        `install_request.report_refused ${row.installId} ${state} (${describeFailure(failure)})`,
                    );
                    await this.settle(row, reported);
                    return 'dropped';
                }
                if (reported !== row.reportedState) {
                    await this.requests.update(
                        { installId: row.installId },
                        { reportedState: reported },
                    );
                }
                return this.retry(row, now, describeFailure(failure));
            }
            reported = state;
        }
        await this.settle(row, reported);
        this.logger.log(`install_request.reported ${row.installId} ${reported}`);
        return 'sent';
    }

    /** Nothing more is owed for the row (`reportedState` recorded when given). */
    private async settle(
        row: EverConnectInstallRequest,
        reported: EverConnectInstallReportState | null = row.reportedState,
    ): Promise<void> {
        await this.requests.update(
            { installId: row.installId },
            { reportedState: reported, reportState: null, reportAttempts: 0, nextReportAt: null },
        );
    }

    private async retry(
        row: EverConnectInstallRequest,
        now: Date,
        code: string,
    ): Promise<InstallReportOutcome> {
        const attempts = row.reportAttempts + 1;
        const wait = RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1];
        await this.requests.update(
            { installId: row.installId },
            { reportAttempts: attempts, nextReportAt: new Date(now.getTime() + wait) },
        );
        this.logger.warn(`install_request.report_retry ${row.installId} (${code})`);
        return 'retry';
    }

    private dropped(row: EverConnectInstallRequest, reason: string): void {
        this.logger.warn(
            `install_request.report_dropped ${row.installId} ${row.reportState} (${reason})`,
        );
    }

    /** Whether `marketplace_installs` is enabled for the tenant link the request reports under. */
    private async linkEnabled(linkId: string | null): Promise<boolean> {
        if (!linkId) return false;
        const links = await this.integrations.linkStates(EVER_INSTALLS_INTEGRATION_KEY);
        return links.some((link) => link.linkId === linkId && link.enabled);
    }
}

/** The report's `Idempotency-Key`: SHA-256 of the install id and the state (hex). */
export function idempotencyKey(installId: string, state: string): string {
    return createHash('sha256').update(`${installId}|${state}`).digest('hex');
}
