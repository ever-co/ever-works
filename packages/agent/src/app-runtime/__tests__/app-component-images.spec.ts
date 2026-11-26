import type { AppComponentInput } from '@ever-works/plugin';

import {
    imageRepositoryOf,
    isDigestPinnedReference,
    pinRecordedComponentImage,
    resolveComponentImages,
    type AppComponentImageAnswer,
} from '../app-component-images';
import { APP_IMAGE_REFERENCE_RESOLVER } from '../app-deploy.orchestrator';
import { APP_IMAGE_REFERENCE_RESOLVER as SHARED_TOKEN } from '../app-component-images';

const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

function component(name: string, image?: string): AppComponentInput {
    return {
        name,
        role: 'web',
        port: 3000,
        replicas: 1,
        writableRootFilesystem: false,
        probes: {},
        resources: { cpu: '250m', memory: '512Mi', memoryLimit: '1Gi' },
        volumes: [],
        primary: false,
        deadlineSeconds: 750,
        internalUrl: `http://${name}.ns.svc.cluster.local`,
        ...(image ? { image } : {}),
    } as AppComponentInput;
}

describe('APP_IMAGE_REFERENCE_RESOLVER', () => {
    it('is one Symbol, whether read from the orchestrator (its public path) or from here', () => {
        expect(APP_IMAGE_REFERENCE_RESOLVER).toBe(SHARED_TOKEN);
    });
});

describe('imageRepositoryOf / isDigestPinnedReference', () => {
    it.each([
        ['ghcr.io/acme/web:1.2.3', 'ghcr.io/acme/web'],
        [`ghcr.io/acme/web@${DIGEST_B}`, 'ghcr.io/acme/web'],
        ['registry.example.com:5000/acme/web:1', 'registry.example.com:5000/acme/web'],
        ['registry.example.com:5000/acme/web', 'registry.example.com:5000/acme/web'],
        ['nginx', 'nginx'],
    ])('%s → %s', (reference, repository) => {
        expect(imageRepositoryOf(reference)).toBe(repository);
    });

    it('accepts only `@sha256:<64 hex>`', () => {
        expect(isDigestPinnedReference(`ghcr.io/acme/web@${DIGEST_B}`)).toBe(true);
        expect(isDigestPinnedReference('ghcr.io/acme/web:1.2.3')).toBe(false);
        expect(isDigestPinnedReference('ghcr.io/acme/web@sha256:abc')).toBe(false);
        expect(isDigestPinnedReference(undefined)).toBe(false);
    });
});

describe('pinRecordedComponentImage (§5.8 / FR-34: a redeploy never re-resolves a tag)', () => {
    it('takes the recorded digest while the spec names the same repository', () => {
        expect(
            pinRecordedComponentImage('ghcr.io/acme/web:1.2.3', `ghcr.io/acme/web@${DIGEST_B}`),
        ).toBe(`ghcr.io/acme/web@${DIGEST_B}`);
        expect(
            pinRecordedComponentImage(`ghcr.io/acme/web@${DIGEST_C}`, `ghcr.io/acme/web@${DIGEST_B}`),
        ).toBe(`ghcr.io/acme/web@${DIGEST_B}`);
    });

    it("keeps the spec's own reference for another repository, a tag or nothing recorded", () => {
        expect(
            pinRecordedComponentImage('ghcr.io/acme/web:1.2.3', `ghcr.io/acme/old@${DIGEST_B}`),
        ).toBe('ghcr.io/acme/web:1.2.3');
        expect(pinRecordedComponentImage('ghcr.io/acme/web:1.2.3', 'ghcr.io/acme/web:1.0.0')).toBe(
            'ghcr.io/acme/web:1.2.3',
        );
        expect(pinRecordedComponentImage('ghcr.io/acme/web:1.2.3', undefined)).toBe(
            'ghcr.io/acme/web:1.2.3',
        );
        expect(pinRecordedComponentImage('', `ghcr.io/acme/web@${DIGEST_B}`)).toBe('');
    });
});

describe('resolveComponentImages (§5.8 for components[].image)', () => {
    it('resolves each distinct reference once, in order, and records the digests by component', async () => {
        const calls: string[] = [];
        const answer = await resolveComponentImages(
            [
                component('api'),
                component('web', 'ghcr.io/acme/web:1.2.3'),
                component('worker', 'ghcr.io/acme/web:1.2.3'),
                component('admin', `ghcr.io/acme/admin@${DIGEST_C}`),
            ],
            async (reference): Promise<AppComponentImageAnswer> => {
                calls.push(reference);
                return reference.includes('@')
                    ? { status: 'resolved', reference, digest: DIGEST_C, resolvedFromTag: false }
                    : {
                          status: 'resolved',
                          reference: `ghcr.io/acme/web@${DIGEST_B}`,
                          digest: DIGEST_B,
                          resolvedFromTag: true,
                      };
            },
        );

        expect(calls).toEqual(['ghcr.io/acme/web:1.2.3', `ghcr.io/acme/admin@${DIGEST_C}`]);
        expect(answer.status).toBe('resolved');
        if (answer.status !== 'resolved') return;
        expect(answer.components.map((entry) => entry.image)).toEqual([
            undefined,
            `ghcr.io/acme/web@${DIGEST_B}`,
            `ghcr.io/acme/web@${DIGEST_B}`,
            `ghcr.io/acme/admin@${DIGEST_C}`,
        ]);
        expect(answer.recorded).toEqual({
            web: `ghcr.io/acme/web@${DIGEST_B}`,
            worker: `ghcr.io/acme/web@${DIGEST_B}`,
            admin: `ghcr.io/acme/admin@${DIGEST_C}`,
        });
        expect(answer.resolvedFromTag).toEqual([
            {
                component: 'web',
                tag: 'ghcr.io/acme/web:1.2.3',
                reference: `ghcr.io/acme/web@${DIGEST_B}`,
            },
        ]);
    });

    it('calls nothing and changes nothing when no component names its own image', async () => {
        const calls: string[] = [];
        const components = [component('api'), component('web')];
        const answer = await resolveComponentImages(components, async (reference) => {
            calls.push(reference);
            return { status: 'refused', code: 'image_not_found', message: 'x' };
        });

        expect(calls).toEqual([]);
        expect(answer).toEqual({
            status: 'resolved',
            components,
            recorded: {},
            resolvedFromTag: [],
        });
    });

    it("ends at the first refusal with the resolver's code, and maps a throw to image_unresolvable", async () => {
        const refused = await resolveComponentImages(
            [component('web', 'ghcr.io/acme/web:gone')],
            async () => ({ status: 'refused', code: 'image_not_found', message: 'answered 404' }),
        );
        expect(refused).toEqual({
            status: 'refused',
            code: 'image_not_found',
            message: 'answered 404',
            component: 'web',
        });

        const thrown = await resolveComponentImages(
            [component('web', 'ghcr.io/acme/web:1')],
            async () => {
                throw new Error('registry timed out');
            },
        );
        expect(thrown).toMatchObject({
            status: 'refused',
            code: 'image_unresolvable',
            message: 'registry timed out',
        });
    });
});
