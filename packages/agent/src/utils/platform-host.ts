/**
 * Platform-owned hosts: the one check that stops a member from adding a name under the platform's own
 * root domains as a custom domain.
 *
 * Every Work's managed `<label>.<EVER_WORKS_DOMAIN>` shares one DNS zone with the platform's own hosts
 * (app, api, auth, docs, ...). A wildcard record sends any name in that zone that has no route of its own
 * to the shared cluster. If a member could add `login.ever.works` as a custom domain, that cluster's
 * Ingress would serve their site on a host that looks like the platform's own, which is phishing on our
 * own domain. A Work gets its address under a platform root from the managed subdomain setting, never
 * from "Add custom domain".
 *
 * This module is pure: the caller passes the roots, which come from
 * `config.everWorks.platformRootDomains()`. It reads no environment variables and imports only
 * `node:url`'s `domainToASCII`, so every writer of a custom host shares one rule: the API routes, the
 * deploy facade, the App domain service, the account import, the k8s `ingressHost` save paths and the
 * deploy service.
 *
 * The rule:
 * - a host is platform-owned when it equals a root or ends in `.` + a root;
 * - the comparison ignores case, surrounding whitespace and leading or trailing dots, and runs on the
 *   IDNA ASCII form (`login．ever．works` and `login。ever。works` are `login.ever.works`);
 * - a root that is unset, empty or only dots is skipped, so it can never match every host;
 * - it matches whole labels only: `evil-ever.works` and `ever.works.evil.com` are not under `ever.works`.
 */

import { domainToASCII } from 'node:url';

/** The stable error code a refused platform host carries, in the API's 400 body and on the error. */
export const PLATFORM_DOMAIN_NOT_ALLOWED = 'PLATFORM_DOMAIN_NOT_ALLOWED';

/** One configured root domain. `null`, `undefined` and blank values are skipped. */
export type PlatformRootDomain = string | null | undefined;

/**
 * Trimmed, in its IDNA ASCII form (which also lowercases and maps fullwidth and ideographic dots to
 * `.`), with leading and trailing dots removed. A value `domainToASCII` cannot convert (a space, a
 * port, a scheme) is kept as it is, lowercased, rather than dropped, so it still matches the way it
 * reads. Anything that is not a string becomes `''`.
 */
export function normalizePlatformHost(value: unknown): string {
    if (typeof value !== 'string') return '';

    const trimmed = value.trim();
    const text = (domainToASCII(trimmed) || trimmed).toLowerCase();
    // A loop, not `/^\.+|\.+$/`: the regex is quadratic on a long run of dots, and this helper also
    // sees input that never went through the DTO's format check.
    let start = 0;
    let end = text.length;
    while (start < end && text.charCodeAt(start) === 46) start++;
    while (end > start && text.charCodeAt(end - 1) === 46) end--;

    return text.slice(start, end);
}

/**
 * The first root that `host` equals or is under, normalized, or `null` when the host is under none of
 * them (or is empty).
 */
export function matchPlatformRootDomain(
    host: unknown,
    roots: readonly PlatformRootDomain[],
): string | null {
    const name = normalizePlatformHost(host);
    if (!name) return null;

    for (const candidate of roots ?? []) {
        const root = normalizePlatformHost(candidate);
        if (!root) continue;
        if (name === root || name.endsWith(`.${root}`)) return root;
    }

    return null;
}

/** Whether `host` equals, or is under, one of the platform's root domains. */
export function isPlatformOwnedHost(host: unknown, roots: readonly PlatformRootDomain[]): boolean {
    return matchPlatformRootDomain(host, roots) !== null;
}

/** The member-facing sentence for a refused host. It names the root, which is public, and nothing else. */
export function platformDomainRefusalMessage(root: string): string {
    return `Domains under ${root} can't be added as a custom domain. Use the managed subdomain setting instead.`;
}

/** The same refusal, worded for the k8s plugin's "Default ingress host" setting. */
export function platformIngressHostRefusalMessage(root: string): string {
    return `Hosts under ${root} can't be used as the default ingress host. Use the managed subdomain setting instead.`;
}

/** The body of every 400 that refuses a platform host. One shape for every route that answers it. */
export interface PlatformDomainNotAllowedBody {
    status: 'error';
    code: typeof PLATFORM_DOMAIN_NOT_ALLOWED;
    message: string;
}

/**
 * The 400 body for a host under `root`: `{ status: 'error', code: 'PLATFORM_DOMAIN_NOT_ALLOWED', message }`.
 * Callers wrap it in their framework's 400 (`new BadRequestException(body)`).
 */
export function platformDomainNotAllowedBody(
    root: string,
    message: string = platformDomainRefusalMessage(root),
): PlatformDomainNotAllowedBody {
    return { status: 'error', code: PLATFORM_DOMAIN_NOT_ALLOWED, message };
}

/** Thrown when a custom domain is under one of the platform's root domains. */
export class PlatformDomainNotAllowedError extends Error {
    readonly code = PLATFORM_DOMAIN_NOT_ALLOWED;

    constructor(
        /** The refused host, normalized. */
        readonly domain: string,
        /** The platform root domain it equals or is under. */
        readonly root: string,
    ) {
        super(platformDomainRefusalMessage(root));
        this.name = 'PlatformDomainNotAllowedError';
    }
}

/** Throws {@link PlatformDomainNotAllowedError} when `host` equals, or is under, one of the roots. */
export function assertNotPlatformHost(host: unknown, roots: readonly PlatformRootDomain[]): void {
    const root = matchPlatformRootDomain(host, roots);
    if (root !== null) {
        throw new PlatformDomainNotAllowedError(normalizePlatformHost(host), root);
    }
}

/**
 * Whether `error` is a {@link PlatformDomainNotAllowedError}. It also checks the `code`, so the answer
 * holds when the error comes from another copy of this module (for example a built package next to
 * its source).
 */
export function isPlatformDomainNotAllowedError(
    error: unknown,
): error is PlatformDomainNotAllowedError {
    if (error instanceof PlatformDomainNotAllowedError) return true;

    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === PLATFORM_DOMAIN_NOT_ALLOWED &&
        typeof (error as { root?: unknown }).root === 'string'
    );
}
