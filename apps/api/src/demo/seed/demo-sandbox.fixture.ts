import { GoalStatus, KbDocumentClass, TaskPriority, TaskStatus } from '@ever-works/agent/entities';
import type { MissionWorkRelation } from '@ever-works/agent/entities';
import type { OnboardingRoleId } from '@ever-works/contracts/api';

/**
 * Platform demo mode — the content of every demo sandbox (design §5.2.3).
 *
 * Plain data, so marketing can tune the wording without touching the seeder
 * (`demo-sandbox-seeder.service.ts`), which turns it into rows through the
 * domain services. Keys (`key`, `missionKey`, `goalKey`, `teamKey`,
 * `agentSlug`) only link entries of this file to each other; every id is
 * generated per sandbox.
 */

export interface DemoFixtureTeam {
    readonly key: string;
    readonly name: string;
    readonly slug: string;
    readonly description: string;
    /** Starter-kit agent templates placed on the team's roster (the first leads it). */
    readonly agentSlugs: readonly string[];
}

export interface DemoFixtureMission {
    readonly key: string;
    readonly title: string;
    readonly description: string;
    readonly teamKey: string;
    /** How the Mission relates to the Project Work (`mission_works.relation`). */
    readonly relation: MissionWorkRelation;
}

export interface DemoFixtureGoalCriterion {
    readonly id: string;
    readonly text: string;
    readonly status: 'open' | 'done';
}

export interface DemoFixtureGoal {
    readonly key: string;
    readonly missionKey: string;
    readonly title: string;
    readonly description: string;
    /**
     * The state the Goal is left in: `completed` (the outcome is recorded as
     * achieved), `active` (in progress) or `draft` (not started).
     */
    readonly status: GoalStatus.COMPLETED | GoalStatus.ACTIVE | GoalStatus.DRAFT;
    readonly definitionOfDone: readonly DemoFixtureGoalCriterion[];
}

export interface DemoFixtureTask {
    readonly goalKey: string;
    readonly title: string;
    readonly description: string;
    /** Reached from `todo` through the ordinary transitions, so the history shows each move. */
    readonly status: TaskStatus.TODO | TaskStatus.IN_PROGRESS | TaskStatus.DONE;
    readonly priority: TaskPriority;
    /** Starter-kit agent template assigned to the Task; `null` = unassigned. */
    readonly agentSlug: string | null;
    /** Posted on the Task's thread in order: by the visitor, or by the Task's Agent. */
    readonly comments: readonly { readonly by: 'user' | 'agent'; readonly body: string }[];
}

export interface DemoFixtureNote {
    readonly path: string;
    readonly title: string;
    readonly class: KbDocumentClass;
    readonly body: string;
}

export interface DemoSandboxFixture {
    readonly organization: {
        readonly name: string;
        /** The slug is `<slugPrefix>-<demo username>`: unique per sandbox, no counter to scan. */
        readonly slugPrefix: string;
    };
    readonly teams: readonly DemoFixtureTeam[];
    /** `OnboardingRoleSeedingService` starter kit: the roles and how many agents to activate. */
    readonly starterKit: {
        readonly roles: readonly OnboardingRoleId[];
        readonly maxAgents: number;
    };
    readonly projectWork: {
        readonly name: string;
        readonly slug: string;
        readonly description: string;
    };
    readonly missions: readonly DemoFixtureMission[];
    readonly goals: readonly DemoFixtureGoal[];
    readonly tasks: readonly DemoFixtureTask[];
    /** Organization knowledge (the Knowledge library), not inherited by Works. */
    readonly knowledgeNotes: readonly DemoFixtureNote[];
    /**
     * The directory Work the visitor generates. Left in draft with no repository: the
     * repository is provisioned when the visitor presses Generate. A Work has no prompt
     * column, so the prompt is its description.
     */
    readonly directoryWork: {
        readonly name: string;
        readonly slug: string;
        readonly prompt: string;
    };
}

export const DEMO_SANDBOX_FIXTURE: DemoSandboxFixture = {
    organization: {
        name: 'Acme Labs (Demo)',
        slugPrefix: 'acme-labs',
    },
    teams: [
        {
            key: 'product',
            name: 'Product',
            slug: 'product',
            description: 'Builds and ships the Acme website.',
            agentSlugs: ['seo-auditor', 'competitive-analyst'],
        },
        {
            key: 'growth',
            name: 'Growth',
            slug: 'growth',
            description: 'Brings visitors to the site and turns them into subscribers.',
            agentSlugs: ['content-marketer', 'social-scheduler'],
        },
    ],
    // marketing → content-marketer, social-scheduler, seo-auditor; product, engineering and
    // research add competitive-analyst (and lead-researcher, past the cap of four).
    starterKit: {
        roles: ['marketing', 'product', 'engineering', 'research'],
        maxAgents: 4,
    },
    projectWork: {
        name: 'Launch the Acme website',
        slug: 'launch-the-acme-website',
        description:
            'Ship the new Acme website, announce it, and grow the newsletter from the launch traffic.',
    },
    missions: [
        {
            key: 'ship-site',
            title: 'Ship the launch site',
            description:
                'Get the new acme.example site live with the launch announcement and a pricing page.',
            teamKey: 'product',
            relation: 'improves',
        },
        {
            key: 'grow-signups',
            title: 'Grow newsletter signups',
            description: 'Turn launch visitors into newsletter subscribers.',
            teamKey: 'growth',
            relation: 'markets',
        },
    ],
    goals: [
        {
            key: 'launch-post',
            missionKey: 'ship-site',
            title: 'Publish the launch blog post',
            description:
                'A launch announcement on the Acme blog, shared on the day the site goes live.',
            status: GoalStatus.COMPLETED,
            definitionOfDone: [
                { id: 'draft-approved', text: 'Draft approved by the team', status: 'done' },
                { id: 'post-live', text: 'Post is live on the Acme blog', status: 'done' },
            ],
        },
        {
            key: 'newsletter-signups',
            missionKey: 'grow-signups',
            title: 'Collect 100 newsletter signups',
            description: 'Reach 100 confirmed newsletter subscribers from the launch traffic.',
            status: GoalStatus.ACTIVE,
            definitionOfDone: [
                { id: 'form-live', text: 'Signup form live on the homepage', status: 'done' },
                { id: 'welcome-emails', text: 'Welcome email sequence sending', status: 'open' },
                { id: 'hundred-subscribers', text: '100 confirmed subscribers', status: 'open' },
            ],
        },
        {
            key: 'pricing-page',
            missionKey: 'ship-site',
            title: 'Add a pricing page',
            description: 'A pricing page with the plans, a comparison table and a FAQ.',
            status: GoalStatus.DRAFT,
            definitionOfDone: [
                { id: 'tiers-agreed', text: 'Pricing tiers agreed', status: 'open' },
                { id: 'page-live', text: 'Pricing page published', status: 'open' },
            ],
        },
    ],
    tasks: [
        {
            goalKey: 'launch-post',
            title: 'Outline the launch announcement',
            description: 'Key messages, the three headline features and a call to action.',
            status: TaskStatus.DONE,
            priority: TaskPriority.P1,
            agentSlug: 'content-marketer',
            comments: [
                {
                    by: 'agent',
                    body: 'Outline ready: problem, three features, quote, call to action.',
                },
                { by: 'user', body: 'Looks good. Lead with the speed improvements.' },
            ],
        },
        {
            goalKey: 'launch-post',
            title: 'Write the launch blog post',
            description: 'About 800 words from the approved outline, with two screenshots.',
            status: TaskStatus.DONE,
            priority: TaskPriority.P1,
            agentSlug: 'content-marketer',
            comments: [{ by: 'agent', body: 'First draft is in the doc, about 780 words.' }],
        },
        {
            goalKey: 'launch-post',
            title: 'Review SEO and publish the post',
            description: 'Title, meta description and internal links, then publish.',
            status: TaskStatus.DONE,
            priority: TaskPriority.P2,
            agentSlug: 'seo-auditor',
            comments: [
                { by: 'agent', body: 'Meta description shortened to 155 characters.' },
                { by: 'user', body: 'Published. Thanks!' },
            ],
        },
        {
            goalKey: 'newsletter-signups',
            title: 'Add a signup form to the homepage',
            description: 'One email field and a short promise of what subscribers get.',
            status: TaskStatus.DONE,
            priority: TaskPriority.P1,
            agentSlug: null,
            comments: [{ by: 'user', body: 'Form is live under the hero section.' }],
        },
        {
            goalKey: 'newsletter-signups',
            title: 'Write the welcome email sequence',
            description: 'Three emails: welcome, best posts, and a product tour.',
            status: TaskStatus.IN_PROGRESS,
            priority: TaskPriority.P2,
            agentSlug: 'content-marketer',
            comments: [
                { by: 'agent', body: 'Email 1 and 2 drafted; working on the product tour.' },
                { by: 'user', body: 'Keep each email under 150 words.' },
            ],
        },
        {
            goalKey: 'newsletter-signups',
            title: 'Share the launch post on social',
            description: 'A short thread and two follow-up posts during launch week.',
            status: TaskStatus.TODO,
            priority: TaskPriority.P3,
            agentSlug: 'social-scheduler',
            comments: [{ by: 'user', body: 'Schedule the first post for launch morning.' }],
        },
        {
            goalKey: 'pricing-page',
            title: 'Research competitor pricing',
            description: 'Plans, prices and limits of the five closest competitors.',
            status: TaskStatus.TODO,
            priority: TaskPriority.P2,
            agentSlug: 'competitive-analyst',
            comments: [{ by: 'user', body: 'Include the free tiers too.' }],
        },
        {
            goalKey: 'pricing-page',
            title: 'Draft the pricing tiers',
            description: 'Three tiers with names, prices and the limits that separate them.',
            status: TaskStatus.TODO,
            priority: TaskPriority.P3,
            agentSlug: null,
            comments: [{ by: 'user', body: 'Wait for the competitor research first.' }],
        },
    ],
    knowledgeNotes: [
        {
            path: 'freeform/launch-checklist.md',
            title: 'Launch checklist',
            class: KbDocumentClass.FREEFORM,
            body: '# Launch checklist\n\n- Site live on the new domain\n- Launch post published\n- Newsletter form tested\n- Social posts scheduled\n',
        },
        {
            path: 'personas/target-audience.md',
            title: 'Target audience',
            class: KbDocumentClass.PERSONAS,
            body: '# Target audience\n\nSmall product teams (2 to 20 people) who want a fast, simple website and a newsletter without hiring an agency.\n',
        },
        {
            path: 'freeform/voice-and-tone.md',
            title: 'Voice and tone',
            class: KbDocumentClass.FREEFORM,
            body: '# Voice and tone\n\nFriendly, direct and short. Plain words, active voice, no jargon.\n',
        },
    ],
    directoryWork: {
        name: 'Awesome AI Coding Tools',
        slug: 'awesome-ai-coding-tools',
        prompt: 'A curated directory of AI coding assistants, code-review bots and agentic IDEs, with pricing and open-source status',
    },
};
