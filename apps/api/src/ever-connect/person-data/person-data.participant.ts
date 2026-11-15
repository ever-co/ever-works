import { Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EverConnectPersonRequest } from '@ever-works/agent/entities';
import { config } from '../../config/constants';
import { EverConnectExtensions } from '../ever-connect-extensions';
import { isPersonExportEnabled } from '../ever-connect.switches';
import type {
    PersonDataParticipant,
    PersonDataRequest,
    PersonExportOutcome,
} from '../identity/person-data-participant.port';
import {
    PersonDataExportBuilder,
    type PersonDataExportDocument,
} from './person-data-export.builder';

/** A platform job id (a ULID). */
const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** How long the address an `exported` answer gives keeps working, from the answer. */
export const PERSON_EXPORT_LINK_DAYS = 30;

/**
 * Where the person downloads their export: a page of the web app, which signs
 * them in and asks the API for their own document. Ever Platform keeps the
 * address and shows it to the person; it never fetches it.
 */
export function personExportUrl(jobId: string, webAppUrl: string = config.webAppUrl()): string {
    return `${webAppUrl.replace(/\/+$/, '')}/api/ever-connect/person-export/${jobId}`;
}

/**
 * Ever Works' part in people's export (and, with its own switch, deletion)
 * requests from Ever Platform, registered with the request handler through
 * {@link EverConnectExtensions} only for what is switched on.
 *
 * **Export** (`EVER_CONNECT_PERSON_EXPORT_ENABLED`): the answer is `exported`
 * with an address on this installation ({@link personExportUrl}). Nothing is
 * prepared or stored: the document is built when the person opens the address,
 * signed in here, and it is always the signed-in account's own data
 * ({@link documentFor}), whoever holds the address. The address works for
 * {@link PERSON_EXPORT_LINK_DAYS} days after the answer.
 */
@Injectable()
export class PersonDataParticipantService implements OnModuleInit {
    private readonly logger = new Logger(PersonDataParticipantService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly builder: PersonDataExportBuilder,
        @Optional() private readonly extensions?: EverConnectExtensions,
    ) {}

    onModuleInit(): void {
        const participant = this.participant();
        if (participant) this.extensions?.providePersonData(participant);
    }

    /** What is switched on, as the request handler calls it; `null` when nothing is. */
    participant(env: Readonly<Record<string, string | undefined>> = process.env) {
        const parts: PersonDataParticipant = {};
        if (isPersonExportEnabled(env)) {
            parts.exportAccounts = (request) => this.exportAccounts(request);
        }
        return parts.exportAccounts ? parts : null;
    }

    /** Answer an export request: the address where the person gets their data. */
    async exportAccounts(request: PersonDataRequest): Promise<PersonExportOutcome> {
        if (!isPersonExportEnabled()) {
            // Never registered while off; a direct call changes nothing either.
            throw new Error('person_export_disabled');
        }
        return { result: 'exported', exportUrl: personExportUrl(request.jobId) };
    }

    /**
     * The signed-in account's own export, for an address an `exported` answer
     * gave. `404` (the same for every case, so the address tells nothing) when
     * the switch is off, the job is not an export this installation answered
     * `exported`, the address is older than {@link PERSON_EXPORT_LINK_DAYS} days,
     * or the account is gone. Never writes.
     */
    async documentFor(
        jobId: string,
        userId: string,
        now = new Date(),
    ): Promise<PersonDataExportDocument> {
        if (!isPersonExportEnabled() || typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
            throw notFound();
        }
        const answer = await this.dataSource
            .getRepository(EverConnectPersonRequest)
            .findOne({ where: { jobId } });
        if (!answer || answer.kind !== 'export' || answer.result !== 'exported') throw notFound();
        const answeredAt = new Date(answer.createdAt).getTime();
        if (
            !Number.isFinite(answeredAt) ||
            now.getTime() - answeredAt > PERSON_EXPORT_LINK_DAYS * 24 * 3_600_000
        ) {
            throw notFound();
        }
        const document = await this.builder.build(userId, now);
        if (!document) throw notFound();
        this.logger.log('ever_connect.person_export.downloaded');
        return document;
    }
}

function notFound(): NotFoundException {
    return new NotFoundException({ code: 'not_found', message: 'No such export.' });
}
