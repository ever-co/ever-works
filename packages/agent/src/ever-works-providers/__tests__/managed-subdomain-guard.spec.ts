import {
    DnsRecordConflictError,
    RESERVED_SUBDOMAIN_LABELS,
    isReservedSubdomainLabel,
    sameDnsContent,
} from '../managed-subdomain-guard';

describe('managed-subdomain-guard', () => {
    describe('RESERVED_SUBDOMAIN_LABELS', () => {
        it('keeps the original spec §7 blocklist', () => {
            for (const label of [
                'www',
                'api',
                'app',
                'admin',
                'mail',
                'auth',
                'docs',
                'status',
                'platform',
                'dashboard',
                'cdn',
                'static',
                'root',
                'mx',
                'ns',
                'ns1',
                'ns2',
            ]) {
                expect(RESERVED_SUBDOMAIN_LABELS.has(label)).toBe(true);
            }
        });

        it('reserves mcp and lb', () => {
            expect(RESERVED_SUBDOMAIN_LABELS.has('mcp')).toBe(true);
            expect(RESERVED_SUBDOMAIN_LABELS.has('lb')).toBe(true);
        });

        it.each([
            'api-dev',
            'api-stage',
            'apidev',
            'apistage',
            'app-dev',
            'appstage',
            'admin-dev',
            'admin-stage',
            'docs-dev',
            'docs-stage',
            'mcp-dev',
            'mcpdev',
            'mcpstage',
        ])('reserves the per-environment variant %s', (label) => {
            expect(RESERVED_SUBDOMAIN_LABELS.has(label)).toBe(true);
        });

        it('does not reserve ordinary tenant labels', () => {
            for (const label of ['my-site', 'ai-coding', 'apiary', 'application', 'mcp-tools']) {
                expect(RESERVED_SUBDOMAIN_LABELS.has(label)).toBe(false);
            }
        });

        it.each([
            'login',
            'signin',
            'sign-in',
            'signup',
            'sign-up',
            'register',
            'account',
            'accounts',
            'billing',
            'pay',
            'payment',
            'payments',
            'checkout',
            'sso',
            'oauth',
            'id',
            'identity',
            'password',
            'reset',
            'verify',
            'security',
            'secure',
            'support',
            'help',
            'portal',
            'console',
            'my',
        ])('reserves the account / sign-in / payment label %s', (label) => {
            expect(RESERVED_SUBDOMAIN_LABELS.has(label)).toBe(true);
            expect(isReservedSubdomainLabel(` ${label.toUpperCase()} `)).toBe(true);
        });

        it('reserves the account labels themselves only, not per-environment variants or longer names', () => {
            for (const label of [
                'login-dev',
                'loginstage',
                'billing-stage',
                'my-shop',
                'helpdesk',
                'identity-lab',
                'paypal-clone',
            ]) {
                expect(RESERVED_SUBDOMAIN_LABELS.has(label)).toBe(false);
            }
        });
    });

    it('isReservedSubdomainLabel ignores case and surrounding spaces', () => {
        expect(isReservedSubdomainLabel(' MCP ')).toBe(true);
        expect(isReservedSubdomainLabel('Api-Dev')).toBe(true);
        expect(isReservedSubdomainLabel('my-site')).toBe(false);
        expect(isReservedSubdomainLabel(undefined)).toBe(false);
    });

    it('sameDnsContent compares like DNS does', () => {
        expect(sameDnsContent('LB.Example.com.', 'lb.example.com')).toBe(true);
        expect(sameDnsContent(' lb.example.com', 'lb.example.com')).toBe(true);
        expect(sameDnsContent('lb.example.com', 'other.example.com')).toBe(false);
        expect(sameDnsContent('', '')).toBe(false);
        expect(sameDnsContent(undefined, null)).toBe(false);
    });

    it('DnsRecordConflictError carries the record it refused to change', () => {
        const error = new DnsRecordConflictError('taken.ever.works', 'CNAME', 'other.example.net');
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('DnsRecordConflictError');
        expect(error).toMatchObject({
            host: 'taken.ever.works',
            existingType: 'CNAME',
            existingContent: 'other.example.net',
        });
    });
});
