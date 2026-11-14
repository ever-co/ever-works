import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { NewPageClient } from '@/components/new';
// `ALL_NEW_CHIP_VALUES` is imported from `@/lib/work-kinds/chip-values` — a
// module WITHOUT `'use client'` — and NOT from `@/components/new`. This page is
// a server component, and a server component that imports a plain value from a
// client module receives a client reference rather than the array, which threw
// `TypeError: a.filter is not a function` out of the server render.
import { ALL_NEW_CHIP_VALUES, type ChipType } from '@/lib/work-kinds/chip-values';
import { templatesAPI } from '@/lib/api/templates';
import { missionsAPI, type MissionTemplateManifestView } from '@/lib/api/missions';
import { getDisabledWorkKinds } from '@/lib/feature-flags/work-kinds';
import {
    blueprintHandoffFormHref,
    readEnabledBlueprintHandoff,
} from '@/lib/works/blueprint-handoff.shared';
import {
    BROWSER_WORKSPACE_SCOPE_HEADER,
    buildWorkspaceHref,
    parseWorkspaceSelector,
    type WorkspaceScope,
} from '@/lib/workspace-scope';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.newPage');
    return { title: t('title') };
}

const VALID_CHIP_TYPES: ChipType[] = [
    'mission',
    'idea',
    'agent',
    'task',
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    // Self-build slice D (EW-766) — an existing code repository as a Work.
    'repo',
    // APW-01 T23 — `/new?type=app`; a disabled App kind falls back below.
    'app',
    // EW-662 (Phase 10) — Company joins the live chip set so
    // `/new?type=company` lands directly on the Register-Company flow.
    'company',
];

/**
 * Phase 6.5 PR CC2 — unified `/new` page (spec §8b).
 *
 * Reads an optional `?type=<chip>` query param to pre-select the
 * chip. PR Q's "+ New Mission" button on `/missions` passes
 * `type=mission`; PR DD's sidebar "+ New" repoint passes no
 * type. When `?type=` is missing, the page picks a sensible
 * default: **Mission** when the user hasn't created any yet
 * (so first-time users land on the persistent-goal kind),
 * otherwise **Idea** (the lighter weight one-shot path).
 *
 * Phase 8 PR Y — also reads an optional `?template=<id>` query
 * param. When set AND the resolved chip is `'mission'`, the
 * server fetches the Mission template's catalog row and forwards
 * its name + description so NewPageClient can pre-fill the
 * prompt.
 *
 * A Blueprint hand-off — also reads `?blueprint=<id>`, `?install=<id>` and
 * `?ever_org=<org>`, the address a person is sent to after installing a
 * Blueprint listing on Ever Platform's marketplace
 * (`/new?type=app&blueprint=…&ever_org=…&install=…`). An App is created on the
 * Work canvas, not from this page's prompt, so such a visit goes straight on to
 * the App create form with the three values kept
 * (`@/lib/works/blueprint-handoff.shared`). Without a `blueprint` spelled like
 * one, for any other chip, or while the hand-off is switched off (the default:
 * `EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED`), nothing here changes.
 */
type SearchParams = Promise<{
    type?: string;
    template?: string;
    blueprint?: string | string[];
    install?: string | string[];
    ever_org?: string | string[];
}>;

/** The workspace the visitor is in, as the proxy read it from the address. */
async function currentWorkspace(): Promise<WorkspaceScope> {
    try {
        return parseWorkspaceSelector((await headers()).get(BROWSER_WORKSPACE_SCOPE_HEADER));
    } catch {
        return { kind: 'personal' };
    }
}

export default async function NewPage({ searchParams }: { searchParams: SearchParams }) {
    const params = await searchParams;
    const raw = (params?.type ?? '').trim().toLowerCase();
    const explicitType: ChipType | null = (VALID_CHIP_TYPES as string[]).includes(raw)
        ? (raw as ChipType)
        : null;

    // Default-chip selection: only ask the API for the mission
    // count when the URL didn't already nail down a chip — saves a
    // round-trip on the common `/new?type=…` paths from /missions
    // and template "Use this" buttons.
    let initialType: ChipType = 'mission';
    if (explicitType) {
        initialType = explicitType;
    } else {
        const missions = await missionsAPI.list().catch(() => []);
        initialType = missions.length > 0 ? 'idea' : 'mission';
    }

    // Gate each work-kind chip behind its `works-<value>` PostHog flag.
    // Fail-open: no PostHog config / errors / missing flags → everything
    // enabled. No cheap user id is available on this page, so we evaluate
    // against the 'anonymous' distinct id (fine for global on/off flags).
    const disabledSet = await getDisabledWorkKinds(ALL_NEW_CHIP_VALUES);
    const disabledKinds = Array.from(disabledSet);

    // A kind disabled by a feature flag must not be preselectable via the
    // `?type=` URL handoff — otherwise a user could deep-link a "Soon"
    // chip into the selected/auto-start state and submit it. If the
    // resolved kind is disabled, drop it back to the safe default
    // (Mission, which is never flag-gated here).
    if (disabledSet.has(initialType)) {
        initialType = 'mission';
    }

    // A Blueprint hand-off (see the header): on to the App create form, in the
    // workspace the visitor is in. After the flag check above, so a disabled
    // App kind is not reachable this way either.
    if (initialType === 'app') {
        const handoff = readEnabledBlueprintHandoff(params ?? {});
        if (handoff) {
            redirect(
                buildWorkspaceHref(await currentWorkspace(), blueprintHandoffFormHref(handoff)),
            );
        }
    }

    let initialPrompt: string | undefined;
    let initialTemplateId: string | undefined;
    let missionTemplate: { id: string; manifest: MissionTemplateManifestView | null } | null = null;
    let missionTemplateDescription = '';
    const templateIdRaw = (params?.template ?? '').trim();
    if (initialType === 'mission' && templateIdRaw.length > 0) {
        const list = await templatesAPI.list('mission').catch(() => ({
            templates: [] as Array<{ id: string; name: string; description?: string | null }>,
        }));
        const tpl = list.templates.find((t) => t.id === templateIdRaw);
        if (tpl) {
            initialTemplateId = tpl.id;
            const description = (tpl.description ?? '').trim();
            initialPrompt = description.length > 0 ? `${tpl.name}\n\n${description}` : tpl.name;
            // APW-08 T40 (APW08-G13) — the template's manifest decides whether "Use this Template"
            // opens the Mission form with the template's fields (a template about an App Work).
            missionTemplate = { id: tpl.id, manifest: await missionsAPI.templateManifest(tpl.id) };
            missionTemplateDescription = description;
        }
    }

    return (
        <NewPageClient
            initialType={initialType}
            initialPrompt={initialPrompt}
            initialTemplateId={initialTemplateId}
            missionTemplate={missionTemplate}
            missionTemplateDescription={missionTemplateDescription}
            disabledKinds={disabledKinds}
        />
    );
}
