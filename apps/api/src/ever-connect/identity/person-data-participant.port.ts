/**
 * The part of Ever Works that deletes or exports a person's account when Ever
 * Platform asks for it. Ever ID connections are removed by the request handler
 * itself; the participant answers for the accounts behind them.
 *
 * Unbound (the default), a deletion is answered `failed` with
 * `account_deletion_pending` and an export `failed` with `export_not_available`:
 * honest answers that keep Ever Platform's receipt open, never a claim that data
 * was kept for a legal reason. A participant that offers only one of the two
 * leaves the other answered as if it were unbound.
 *
 * Bound either through {@link EVER_PERSON_DATA_PARTICIPANT} or, by a module
 * switched on separately, through `EverConnectExtensions.providePersonData`.
 */

export const EVER_PERSON_DATA_PARTICIPANT = Symbol('EVER_PERSON_DATA_PARTICIPANT');

/** What a deletion did with the accounts. */
export type PersonDeletionOutcome =
    | { readonly result: 'deleted' | 'anonymised' }
    /** The statute or contract clause the data is kept under (1-200 characters, never personal data). */
    | { readonly result: 'retained_legal'; readonly legalBasis: string };

/** Where the person's export can be fetched (`https`, never fetched by Ever Platform). */
export interface PersonExportOutcome {
    readonly result: 'exported';
    readonly exportUrl: string;
}

export interface PersonDataRequest {
    /** The local accounts linked to the person (never empty). */
    readonly userIds: readonly string[];
    /** Ever Platform's job id, for the participant's own records. */
    readonly jobId: string;
    /** When Ever Platform expects the answer. */
    readonly respondBy: string;
}

export interface PersonDataParticipant {
    /** Absent: deletions are answered as without a participant. */
    deleteAccounts?(request: PersonDataRequest): Promise<PersonDeletionOutcome>;
    /** Absent: exports are answered as without a participant. */
    exportAccounts?(request: PersonDataRequest): Promise<PersonExportOutcome>;
}
