import 'server-only';
import { headers } from 'next/headers';

/**
 * The visitor's address, for an API call made on the visitor's behalf from the web server (a
 * server action or a server component), so the API's per-IP limits, captcha checks and session
 * records apply to the visitor rather than to the web server as a whole.
 *
 * The incoming `X-Forwarded-For` chain is passed on WHOLE. Its left-most entry
 * is whatever the caller sent, so picking it would let a caller rotate it past
 * the limit; with the full chain the API resolves the address the same way it
 * does for a request that reaches it directly (its `TRUST_PROXY_HOPS` counts
 * from the right, where the ingress appended the real peer). `X-Real-IP`, set
 * by the ingress, is the fallback when there is no chain.
 */
export async function clientIpHeaders(): Promise<Record<string, string>> {
    const incoming = await headers();
    const chain = incoming.get('x-forwarded-for')?.trim();
    if (chain) return { 'X-Forwarded-For': chain };
    const realIp = incoming.get('x-real-ip')?.trim();
    return realIp ? { 'X-Forwarded-For': realIp } : {};
}
