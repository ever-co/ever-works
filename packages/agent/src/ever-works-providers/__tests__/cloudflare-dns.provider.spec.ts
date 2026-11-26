import {
    CloudflareDnsError,
    CloudflareDnsProvider,
    EverWorksDnsService,
    type CloudflareDnsConfig,
} from '../cloudflare-dns.provider';
import { DnsRecordConflictError } from '../managed-subdomain-guard';

describe('CloudflareDnsProvider (EW-617 G5)', () => {
    type FetchCall = { url: string; init: RequestInit };

    function buildProvider(
        opts: {
            listResult?: any[];
            /** Per-type lookup results (`?type=`); overrides `listResult` when set. */
            listByType?: Record<string, any[]>;
            createResult?: any;
            updateResult?: any;
            deleteOk?: boolean;
            deleteStatus?: number;
            deleteBody?: any;
            targetHostname?: string;
            manageForeignRecords?: boolean;
            previousTargetHostnames?: string[];
        } = {},
    ) {
        const calls: FetchCall[] = [];
        const fakeFetch = jest.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            const method = (init.method ?? 'GET').toUpperCase();
            if (method === 'GET' && url.includes('/dns_records?')) {
                // Like the real API: `type` filters; no `type` lists every record of the name.
                const type = new URL(url).searchParams.get('type');
                const result = opts.listByType
                    ? type
                        ? (opts.listByType[type] ?? [])
                        : Object.values(opts.listByType).flat()
                    : (opts.listResult ?? []);
                return new Response(JSON.stringify({ success: true, result }), { status: 200 });
            }
            if (method === 'POST' && url.endsWith('/dns_records')) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: opts.createResult ?? {
                            id: 'rec-new',
                            type: 'CNAME',
                            name: JSON.parse(init.body as string).name,
                            content: JSON.parse(init.body as string).content,
                        },
                    }),
                    { status: 200 },
                );
            }
            if (method === 'PUT' && url.includes('/dns_records/')) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: opts.updateResult ?? {
                            id: 'rec-existing',
                            type: 'CNAME',
                            name: JSON.parse(init.body as string).name,
                            content: JSON.parse(init.body as string).content,
                        },
                    }),
                    { status: 200 },
                );
            }
            if (method === 'DELETE' && url.includes('/dns_records/')) {
                if (opts.deleteOk === false) {
                    return new Response(
                        JSON.stringify({
                            success: false,
                            errors: opts.deleteBody ?? [{ code: 7003, message: 'no route' }],
                        }),
                        { status: opts.deleteStatus ?? 404 },
                    );
                }
                return new Response(JSON.stringify({ success: true, result: { id: 'x' } }), {
                    status: 200,
                });
            }
            throw new Error(`Unexpected fetch ${method} ${url}`);
        }) as any;

        const provider = new CloudflareDnsProvider(
            {
                apiToken: 'tk',
                zoneId: 'zone1',
                rootDomain: 'ever.works',
                targetHostname: opts.targetHostname ?? 'k8s.lb.example',
                manageForeignRecords: opts.manageForeignRecords,
                previousTargetHostnames: opts.previousTargetHostnames,
            },
            fakeFetch,
        );

        return { provider, calls, fakeFetch };
    }

    it('creates a fresh CNAME when no record exists', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });
        const result = await provider.ensureWorkSubdomain('ai-coding');

        expect(result.name).toBe('ai-coding.ever.works');
        expect(result.content).toBe('k8s.lb.example');
        // CNAME lookup, then every record of the name (anything else blocks a CNAME), then POST.
        expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'POST']);
        expect(calls[0].url).toContain('name=ai-coding.ever.works');
        expect(calls.slice(0, 2).map((c) => new URL(c.url).searchParams.get('type'))).toEqual([
            'CNAME',
            null,
        ]);
        const body = JSON.parse(calls[2].init.body as string);
        expect(body).toMatchObject({
            type: 'CNAME',
            name: 'ai-coding.ever.works',
            content: 'k8s.lb.example',
            proxied: false,
            ttl: 1,
        });
    });

    it('proxies the CNAME when the target is a Cloudflare Tunnel', async () => {
        // `*.cfargotunnel.com` only resolves through Cloudflare's proxy — an
        // unproxied CNAME there resolves to an unroutable placeholder and the
        // tenant site is dead on the public internet.
        const tunnel = '5a1c27a6-7d93-4f25-a329-3154995e16db.cfargotunnel.com';
        const { provider, calls } = buildProvider({ listResult: [], targetHostname: tunnel });

        await provider.ensureWorkSubdomain('ai-coding');

        const post = calls.find((c) => (c.init.method ?? '').toUpperCase() === 'POST');
        const body = JSON.parse(post!.init.body as string);
        expect(body).toMatchObject({ content: tunnel, proxied: true });
    });

    it('proxies the CNAME when updating a drifted record onto a tunnel target', async () => {
        const tunnel = '5a1c27a6-7d93-4f25-a329-3154995e16db.cfargotunnel.com';
        const { provider, calls } = buildProvider({
            targetHostname: tunnel,
            // Repointing a record aimed elsewhere needs a wholly managed zone.
            manageForeignRecords: true,
            listResult: [
                {
                    id: 'rec-drift',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'old.lb.example',
                },
            ],
        });

        await provider.ensureWorkSubdomain('ai-coding');

        // `patchRecord` issues a PUT (full record replace), not a PATCH.
        const update = calls.find((c) => (c.init.method ?? '').toUpperCase() === 'PUT');
        expect(update).toBeDefined();
        expect(JSON.parse(update!.init.body as string)).toMatchObject({
            content: tunnel,
            proxied: true,
        });
    });

    it('returns the existing record when content already matches', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-existing',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'k8s.lb.example',
                },
            ],
        });
        const result = await provider.ensureWorkSubdomain('ai-coding');
        expect(result.id).toBe('rec-existing');
        // GET only — no POST/PUT.
        expect(calls).toHaveLength(1);
        expect(calls[0].init.method).toBe('GET');
    });

    it('treats a CNAME that differs only in case or a trailing dot as in sync', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-existing',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'K8S.LB.Example.',
                },
            ],
        });
        const result = await provider.ensureWorkSubdomain('ai-coding');
        expect(result.id).toBe('rec-existing');
        expect(calls.map((c) => c.init.method)).toEqual(['GET']);
    });

    it("refuses to repoint a CNAME aimed at another target (one of the zone's other hosts)", async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-other-host',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'other-host.example.net',
                },
            ],
        });
        await expect(provider.ensureWorkSubdomain('ai-coding')).rejects.toBeInstanceOf(
            DnsRecordConflictError,
        );
        // Looked it up, wrote nothing.
        expect(calls.map((c) => c.init.method)).toEqual(['GET']);
    });

    it('PUTs an updated CNAME when the content drifted and the zone is wholly managed', async () => {
        const { provider, calls } = buildProvider({
            manageForeignRecords: true,
            listResult: [
                {
                    id: 'rec-drifted',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'old.lb.example',
                },
            ],
        });
        const result = await provider.ensureWorkSubdomain('ai-coding');
        expect(calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
        expect(calls[1].url).toContain('/dns_records/rec-drifted');
        expect(result.content).toBe('k8s.lb.example');
    });

    it.each(['mcp', 'api-dev', 'appstage', 'lb'])(
        'refuses the reserved platform label %s without calling Cloudflare',
        async (slug) => {
            const { provider, calls } = buildProvider();
            await expect(provider.ensureWorkSubdomain(slug)).rejects.toThrow(/reserved/);
            await expect(provider.removeWorkSubdomain(slug)).rejects.toThrow(/reserved/);
            expect(calls).toHaveLength(0);
        },
    );

    it('rejects slugs that fail the DNS-safe regex', async () => {
        const { provider } = buildProvider();
        await expect(provider.ensureWorkSubdomain('NOT_OK')).rejects.toThrow(/Invalid slug/);
    });

    it('no-ops when removing a non-existent record', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });
        await expect(provider.removeWorkSubdomain('gone')).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0].init.method).toBe('GET');
    });

    it('deletes the record when one exists on the managed target', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-to-go',
                    type: 'CNAME',
                    name: 'foo.ever.works',
                    content: 'k8s.lb.example',
                },
            ],
        });
        await provider.removeWorkSubdomain('foo');
        expect(calls.map((c) => c.init.method)).toEqual(['GET', 'DELETE']);
        expect(calls[1].url).toContain('/dns_records/rec-to-go');
    });

    it('refuses to delete a record aimed at another target', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-other-host',
                    type: 'CNAME',
                    name: 'foo.ever.works',
                    content: 'other-host.example.net',
                },
            ],
        });
        await expect(provider.removeWorkSubdomain('foo')).rejects.toBeInstanceOf(
            DnsRecordConflictError,
        );
        expect(calls.map((c) => c.init.method)).toEqual(['GET']);
    });

    it.each(['mcp.ever.works', 'api-dev.ever.works', 'lb.ever.works'])(
        'host-keyed ensureRecord/removeRecord refuse the reserved host %s without calling Cloudflare',
        async (host) => {
            const { provider, calls } = buildProvider();
            await expect(
                provider.ensureRecord({ host, type: 'CNAME', target: 'k8s.lb.example' }),
            ).rejects.toThrow(/reserved/);
            await expect(provider.removeRecord({ host })).rejects.toThrow(/reserved/);
            expect(calls).toHaveLength(0);
        },
    );

    it('still manages a deeper name whose first label happens to be reserved', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });

        await provider.ensureRecord({
            host: 'mcp.tenant.ever.works',
            type: 'CNAME',
            target: 'k8s.lb.example',
        });

        expect(calls.some((c) => (c.init.method ?? '').toUpperCase() === 'POST')).toBe(true);
    });

    it('bounds every Cloudflare call with a timeout signal', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });

        await provider.recordExists('free.ever.works');

        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    describe('recordExists', () => {
        it('sees a host that has only an AAAA record (Workers custom domain / route)', async () => {
            const { provider, calls } = buildProvider({
                listByType: {
                    AAAA: [
                        {
                            id: 'rec-worker',
                            type: 'AAAA',
                            name: 'crm.ever.works',
                            content: '100::',
                        },
                    ],
                },
            });

            await expect(provider.recordExists('crm.ever.works')).resolves.toBe(true);
            // One exact-name lookup with no type filter.
            expect(calls).toHaveLength(1);
            expect(new URL(calls[0].url).searchParams.get('name')).toBe('crm.ever.works');
            expect(new URL(calls[0].url).searchParams.has('type')).toBe(false);
        });

        it.each([
            ['TXT', 'v=spf1 -all'],
            ['MX', 'mx.example.net'],
            ['HTTPS', '1 . alpn="h2"'],
        ])('sees a host that has only a %s record', async (type, content) => {
            const { provider } = buildProvider({
                listByType: { [type]: [{ id: 'r', type, name: 'only.ever.works', content }] },
            });

            await expect(provider.recordExists('only.ever.works')).resolves.toBe(true);
        });

        it('is false when the name has no record of any type', async () => {
            const { provider, calls } = buildProvider({ listByType: {} });

            await expect(provider.recordExists('free.ever.works')).resolves.toBe(false);
            expect(calls).toHaveLength(1);
            expect(calls[0].init.method ?? 'GET').toBe('GET');
        });
    });

    describe('IDnsOperations guard (ensureRecord / removeRecord)', () => {
        const foreign = {
            id: 'rec-other-host',
            type: 'CNAME',
            name: 'taken.ever.works',
            content: 'other-host.example.net',
        };

        it('ensureRecord refuses to overwrite a record aimed at a foreign target', async () => {
            const { provider, calls } = buildProvider({ listResult: [foreign] });

            await expect(
                provider.ensureRecord({
                    host: 'taken.ever.works',
                    type: 'CNAME',
                    target: 'k8s.lb.example',
                }),
            ).rejects.toMatchObject({
                name: 'DnsRecordConflictError',
                host: 'taken.ever.works',
                existingContent: 'other-host.example.net',
            });
            // No PUT (repoint) and no POST: the only request was the lookup.
            expect(calls.map((c) => c.init.method)).toEqual(['GET']);
        });

        it('ensureRecord leaves a record already on the target alone', async () => {
            const { provider, calls } = buildProvider({
                listResult: [{ ...foreign, content: 'k8s.lb.example' }],
            });

            const result = await provider.ensureRecord({
                host: 'taken.ever.works',
                type: 'CNAME',
                target: 'k8s.lb.example',
            });

            expect(result.id).toBe('rec-other-host');
            expect(calls.map((c) => c.init.method)).toEqual(['GET']);
        });

        it('ensureRecord creates a missing record', async () => {
            const { provider, calls } = buildProvider({ listResult: [] });

            await provider.ensureRecord({
                host: 'fresh.ever.works',
                type: 'CNAME',
                target: 'k8s.lb.example',
            });

            expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'POST']);
        });

        it('ensureRecord refuses a CNAME where the name already has only a TXT record', async () => {
            const { provider, calls } = buildProvider({
                listByType: {
                    TXT: [{ id: 'r', type: 'TXT', name: 'txt.ever.works', content: 'v=spf1 -all' }],
                },
            });

            await expect(
                provider.ensureRecord({
                    host: 'txt.ever.works',
                    type: 'CNAME',
                    target: 'k8s.lb.example',
                }),
            ).rejects.toMatchObject({ name: 'DnsRecordConflictError', existingType: 'TXT' });
            expect(calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
        });

        it('ensureRecord lets an A record be created next to a TXT (they coexist)', async () => {
            const { provider, calls } = buildProvider({
                listByType: {
                    TXT: [{ id: 'r', type: 'TXT', name: 'site.ever.works', content: 'verify=1' }],
                },
            });

            await provider.ensureRecord({
                host: 'site.ever.works',
                type: 'A',
                target: '203.0.113.9',
            });

            expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'POST']);
        });

        it('ensureRecord refuses a CNAME where the name already has a foreign AAAA (Workers domain)', async () => {
            const { provider, calls } = buildProvider({
                listByType: {
                    AAAA: [
                        {
                            id: 'rec-worker',
                            type: 'AAAA',
                            name: 'crm.ever.works',
                            content: '100::',
                        },
                    ],
                },
            });

            await expect(
                provider.ensureRecord({
                    host: 'crm.ever.works',
                    type: 'CNAME',
                    target: 'k8s.lb.example',
                }),
            ).rejects.toMatchObject({ name: 'DnsRecordConflictError', existingType: 'AAAA' });
            expect(calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
        });

        it('ensureWorkSubdomain refuses a CNAME where the name already has a foreign A record', async () => {
            const { provider, calls } = buildProvider({
                listByType: {
                    A: [
                        { id: 'rec-a', type: 'A', name: 'site.ever.works', content: '203.0.113.7' },
                    ],
                },
            });

            await expect(provider.ensureWorkSubdomain('site')).rejects.toBeInstanceOf(
                DnsRecordConflictError,
            );
            expect(calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
        });

        it('repoints a record left on a previous LB target (operator-declared move)', async () => {
            const { provider, calls } = buildProvider({
                previousTargetHostnames: ['old-lb.example'],
                listResult: [{ ...foreign, content: 'old-lb.example' }],
            });

            await provider.ensureRecord({
                host: 'taken.ever.works',
                type: 'CNAME',
                target: 'k8s.lb.example',
            });

            expect(calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
            expect(JSON.parse(calls[1].init.body as string)).toMatchObject({
                content: 'k8s.lb.example',
            });
        });

        it('deletes a Work record left on a previous LB target', async () => {
            const { provider, calls } = buildProvider({
                previousTargetHostnames: ['old-lb.example'],
                listResult: [
                    {
                        id: 'rec-old',
                        type: 'CNAME',
                        name: 'foo.ever.works',
                        content: 'old-lb.example',
                    },
                ],
            });

            await provider.removeWorkSubdomain('foo');

            expect(calls.map((c) => c.init.method)).toEqual(['GET', 'DELETE']);
        });

        it('ensureRecord repoints any record when the zone is wholly managed (apps zone)', async () => {
            const { provider, calls } = buildProvider({
                manageForeignRecords: true,
                listResult: [{ ...foreign, type: 'A', content: '203.0.113.10' }],
            });

            await provider.ensureRecord({
                host: 'taken.ever.works',
                type: 'A',
                target: '203.0.113.20',
            });

            expect(calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
            expect(JSON.parse(calls[1].init.body as string)).toMatchObject({
                content: '203.0.113.20',
            });
        });

        it('removeRecord refuses to delete a record aimed at a foreign target', async () => {
            const { provider, calls } = buildProvider({ listResult: [foreign] });

            await expect(
                provider.removeRecord({ host: 'taken.ever.works', type: 'CNAME' }),
            ).rejects.toBeInstanceOf(DnsRecordConflictError);
            expect(calls.map((c) => c.init.method)).toEqual(['GET']);
        });

        it('removeRecord deletes a record on the managed target', async () => {
            const { provider, calls } = buildProvider({
                listResult: [{ ...foreign, content: 'k8s.lb.example' }],
            });

            await provider.removeRecord({ host: 'taken.ever.works', type: 'CNAME' });

            expect(calls.map((c) => c.init.method)).toEqual(['GET', 'DELETE']);
        });
    });

    it('throws CloudflareDnsError on a non-success API response', async () => {
        const fakeFetch = jest.fn(
            async () =>
                new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), {
                    status: 401,
                }),
        ) as any;
        const provider = new CloudflareDnsProvider(
            { apiToken: 'bad', zoneId: 'z', rootDomain: 'ever.works', targetHostname: 'lb' },
            fakeFetch,
        );
        await expect(provider.ensureWorkSubdomain('x')).rejects.toThrow(CloudflareDnsError);
    });

    it('sends bearer authorization on every request', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });
        await provider.ensureWorkSubdomain('ai-coding');
        for (const c of calls) {
            expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer tk');
        }
    });
});

describe('EverWorksDnsService (EW-617 G5)', () => {
    const ENV_KEYS = [
        'CLOUDFLARE_API_TOKEN',
        'CLOUDFLARE_ZONE_ID',
        'EVER_WORKS_DOMAIN',
        'EVER_WORKS_DEPLOY_LB_HOSTNAME',
        'EVER_WORKS_DEPLOY_LB_PREVIOUS_HOSTNAMES',
    ] as const;

    const previous: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            previous[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (previous[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = previous[k];
            }
        }
    });

    it('returns null from getProvider() when env is unset (dev / preview)', () => {
        const svc = new EverWorksDnsService();
        expect(svc.getProvider()).toBeNull();
    });

    it('caches the null result so we do not re-read env per call', () => {
        const svc = new EverWorksDnsService();
        const a = svc.getProvider();
        const b = svc.getProvider();
        expect(a).toBe(b);
        expect(a).toBeNull();
    });

    it('builds a provider once env is fully configured', () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb.example';

        const svc = new EverWorksDnsService();
        const provider = svc.getProvider();
        expect(provider).toBeInstanceOf(CloudflareDnsProvider);
    });

    it('defaults rootDomain to "ever.works" when env is not overridden', () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';
        const svc = new EverWorksDnsService();
        expect(svc.ingressHostFor('ai-coding')).toBe('ai-coding.ever.works');
    });

    it('respects EVER_WORKS_DOMAIN override for ingressHostFor', () => {
        process.env.EVER_WORKS_DOMAIN = 'preview.ever.works';
        const svc = new EverWorksDnsService();
        expect(svc.ingressHostFor('ai-coding')).toBe('ai-coding.preview.ever.works');
    });

    it('swallows ensureWorkSubdomain errors so a flaky DNS does not abort deploys', async () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';

        const svc = new EverWorksDnsService();
        const provider = svc.getProvider()!;
        jest.spyOn(provider, 'ensureWorkSubdomain').mockRejectedValue(new Error('boom'));

        // A transient failure still lets the deploy route the host (true).
        await expect(svc.ensureWorkSubdomain('ai-coding')).resolves.toBe(true);
    });

    it('answers false (do not route) when the name belongs to another host in the zone', async () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';

        const svc = new EverWorksDnsService();
        const provider = svc.getProvider()!;
        jest.spyOn(provider, 'ensureWorkSubdomain').mockRejectedValue(
            new DnsRecordConflictError('taken.ever.works', 'CNAME', 'other.example.net'),
        );

        await expect(svc.ensureWorkSubdomain('taken')).resolves.toBe(false);
    });

    it('answers false for a reserved platform slug without calling the provider', async () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';

        const svc = new EverWorksDnsService();
        const ensure = jest.spyOn(svc.getProvider()!, 'ensureWorkSubdomain');

        await expect(svc.ensureWorkSubdomain('mcp')).resolves.toBe(false);
        expect(ensure).not.toHaveBeenCalled();
    });

    it('answers true for a successfully ensured record', async () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';

        const svc = new EverWorksDnsService();
        jest.spyOn(svc.getProvider()!, 'ensureWorkSubdomain').mockResolvedValue({
            id: 'r',
            type: 'CNAME',
            name: 'ai-coding.ever.works',
            content: 'k8s.lb',
        });

        await expect(svc.ensureWorkSubdomain('ai-coding')).resolves.toBe(true);
    });

    it('getZoneProbe needs only the token and zone (no LB target)', () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';

        const svc = new EverWorksDnsService();
        expect(svc.getProvider()).toBeNull();
        const probe = svc.getZoneProbe();
        expect(probe).toBeInstanceOf(CloudflareDnsProvider);
        expect(probe!.rootDomain()).toBe('ever.works');
    });

    it('getZoneProbe is the provider itself when the LB target is configured, and null without a zone', () => {
        const unconfigured = new EverWorksDnsService();
        expect(unconfigured.getZoneProbe()).toBeNull();

        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';
        const svc = new EverWorksDnsService();
        expect(svc.getZoneProbe()).toBe(svc.getProvider());
    });

    it('reads earlier LB hostnames from EVER_WORKS_DEPLOY_LB_PREVIOUS_HOSTNAMES', () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';
        process.env.EVER_WORKS_DEPLOY_LB_PREVIOUS_HOSTNAMES = ' old-lb.example , ,older.example ';

        const provider = new EverWorksDnsService().getProvider()!;
        const { config } = provider as unknown as { config: CloudflareDnsConfig };

        expect(config.previousTargetHostnames).toEqual(['old-lb.example', 'older.example']);
    });
});
