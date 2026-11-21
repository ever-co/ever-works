import { EverWorksGitProvider } from '../../ever-works-providers/ever-works-git.provider';
import type { EverWorksGitHttpFetch } from '../../ever-works-providers/ever-works-git.provider';

/**
 * Platform demo mode — the GitHub double the demo Work specs share
 * (`work-lifecycle.demo.spec.ts`, `work-generation.demo.spec.ts`).
 *
 * The real provider, its GitHub calls going to `fetchImpl`. It records into a ledger double:
 * on a demo instance with no repository ledger bound it refuses every create (ruling R22).
 */
export class FetchInjectedEverWorksGit extends EverWorksGitProvider {
    /** The demo topic calls (`PUT …/topics`, Task 10 R27), kept out of `fetchImpl`'s create count. */
    readonly topicCalls: string[] = [];

    constructor(private readonly fetchImpl: EverWorksGitHttpFetch) {
        super({ record: jest.fn().mockResolvedValue(undefined) });
    }

    override createRepository(options: Parameters<EverWorksGitProvider['createRepository']>[0]) {
        const routed = (async (url: string, init?: RequestInit) => {
            if (init?.method === 'PUT' && url.endsWith('/topics')) {
                this.topicCalls.push(url);
                return new Response(JSON.stringify({ names: ['ever-works-demo'] }), {
                    status: 200,
                });
            }
            return this.fetchImpl(url, init);
        }) as EverWorksGitHttpFetch;
        return super.createRepository({ ...options, fetchImpl: routed });
    }
}

/** GitHub answering `POST /orgs/{org}/repos` with 201 for whatever name was asked. */
export function githubCreates(org: string): jest.Mock {
    return jest.fn(async (_url: string, init: RequestInit) => {
        const { name } = JSON.parse(init.body as string) as { name: string };
        return new Response(
            JSON.stringify({
                name,
                owner: { login: org },
                full_name: `${org}/${name}`,
                html_url: `https://github.com/${org}/${name}`,
                clone_url: `https://github.com/${org}/${name}.git`,
                private: true,
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
        );
    });
}
