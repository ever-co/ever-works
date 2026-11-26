/**
 * APW-03 schema §10 `components[].image` — the components of a published-image App that run their
 * **own** image, and the two rules every caller applies to them:
 *
 * - **§5.8's identity, once per distinct reference.** {@link resolveComponentImages} hands each
 *   distinct component image to the App image resolver (T72): a tag is resolved to its digest, a
 *   digest is checked to exist, and the first refusal ends the caller's run with the resolver's own
 *   code. The deploy orchestrator and the verification target both call it, so a component never
 *   runs a moving tag on either path.
 * - **A redeploy keeps what the first Deployment resolved.** {@link pinRecordedComponentImage} swaps
 *   a component's reference for the digest-pinned one a previous Deployment recorded
 *   (`appRender.componentImages`, by component name) when the spec still names the same repository —
 *   §5.8's "a rollback redeploys the recorded `specCommitSha` and digest and **never** re-resolves
 *   the tag", for component images as for the App's.
 *
 * Pure functions: no I/O of their own (the resolver is passed in), no clock, no logger.
 */
import type { AppComponentInput } from '@ever-works/plugin';

/**
 * DI token for the App image reference resolver (APW-06 T72, `app-image-reference.resolver.ts`).
 * Re-exported by `app-deploy.orchestrator.ts`, its public path; declared here, in a file with no
 * imports of its own, so the deploy orchestrator and the verification target share one `Symbol`
 * without an import cycle.
 */
export const APP_IMAGE_REFERENCE_RESOLVER = Symbol('APP_IMAGE_REFERENCE_RESOLVER');

/** One resolver answer — the shape of `AppImageReferenceResolver.resolve`'s (T72). */
export type AppComponentImageAnswer =
    | { status: 'resolved'; reference: string; digest: string; resolvedFromTag: boolean }
    | { status: 'refused'; code: string; message: string };

/** What {@link resolveComponentImages} answers. */
export type AppComponentImagesResult =
    | {
          status: 'resolved';
          /** The components, each own image replaced by its `<repository>@<digest>`. */
          components: readonly AppComponentInput[];
          /** Component name → the reference it runs, for `appRender.componentImages`. */
          recorded: Record<string, string>;
          /** The components whose spec named a tag (§5.8:879's `image_not_pinned`). */
          resolvedFromTag: ReadonlyArray<{ component: string; reference: string }>;
      }
    | { status: 'refused'; code: string; message: string; component: string };

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

/** Whether a reference is pinned by digest — `<repository>@sha256:<64 hex>`. */
export function isDigestPinnedReference(reference: string | null | undefined): boolean {
    return DIGEST_PINNED.test(String(reference ?? '').trim());
}

/** `<repository>` of a reference: a colon is a tag only when it follows the last `/`. */
export function imageRepositoryOf(reference: string | null | undefined): string {
    const value = String(reference ?? '').trim();
    const at = value.indexOf('@');
    if (at >= 0) return value.slice(0, at);

    const colon = value.lastIndexOf(':');
    const slash = value.lastIndexOf('/');

    return colon > slash ? value.slice(0, colon) : value;
}

/**
 * The reference a component runs on a redeploy: the digest-pinned one a previous Deployment
 * recorded for it, when the spec still names that repository; otherwise the spec's own. A recorded
 * value that is not digest-pinned is ignored — only a digest can promise the same bytes.
 */
export function pinRecordedComponentImage(
    reference: string,
    recorded: string | null | undefined,
): string {
    const own = String(reference ?? '').trim();
    const pinned = String(recorded ?? '').trim();

    if (!own || !isDigestPinnedReference(pinned)) return own;

    return imageRepositoryOf(own) === imageRepositoryOf(pinned) ? pinned : own;
}

/**
 * §5.8 for every component that names its own image: each distinct reference is resolved once, in
 * component order, and the components come back with `<repository>@<digest>`. Components without an
 * own image are returned as they are, and a render input that names none calls `resolve` not once.
 */
export async function resolveComponentImages(
    components: readonly AppComponentInput[] | null | undefined,
    resolve: (reference: string) => Promise<AppComponentImageAnswer>,
): Promise<AppComponentImagesResult> {
    const list = [...(components ?? [])];
    const resolved = new Map<string, string>();
    const resolvedFromTag: Array<{ component: string; reference: string }> = [];

    for (const component of list) {
        const reference = String(component?.image ?? '').trim();
        if (!reference || resolved.has(reference)) continue;

        let answer: AppComponentImageAnswer;
        try {
            answer = await resolve(reference);
        } catch (error) {
            answer = {
                status: 'refused',
                code: 'image_unresolvable',
                message: error instanceof Error ? error.message : String(error),
            };
        }

        const name = String(component?.name ?? '');
        if (answer?.status !== 'resolved' || !String(answer.reference ?? '').trim()) {
            return {
                status: 'refused',
                code: answer?.status === 'refused' ? answer.code : 'image_unresolvable',
                message:
                    answer?.status === 'refused'
                        ? answer.message
                        : 'The App image reference resolver answered nothing.',
                component: name,
            };
        }

        resolved.set(reference, answer.reference);
        if (answer.resolvedFromTag) {
            resolvedFromTag.push({ component: name, reference: answer.reference });
        }
    }

    const recorded: Record<string, string> = {};
    const out = list.map((component) => {
        const reference = String(component?.image ?? '').trim();
        const pinned = reference ? resolved.get(reference) : undefined;
        if (!pinned) return component;
        recorded[String(component.name)] = pinned;
        return pinned === component.image ? component : { ...component, image: pinned };
    });

    return { status: 'resolved', components: out, recorded, resolvedFromTag };
}
