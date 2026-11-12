import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from './registry.all';
import { addsAgentToTask, redirectsNotificationChannel, redirectsWebhook } from './privileged';

/**
 * The chat assistant fills a tool's request `body` from its `bodyHint`. The API
 * validates bodies with `whitelist` + `forbidNonWhitelisted`, so a hint naming
 * a field the DTO does not declare — or leaving out a required one — makes the
 * tool answer 400 on every call. An audit of all 374 generated entries against
 * the DTOs (2026-11-11) found 30 such hints; this pins each corrected one to
 * the DTO it feeds: the required fields must be named, the old wrong names
 * must not be.
 */
const CASES: Array<{
    tool: string;
    dto: string;
    names: string[];
    notNamed?: string[];
}> = [
    { tool: 'post_task_chat', dto: 'PostTaskChatDto', names: ['body'], notNamed: ['content'] },
    { tool: 'add_task_assignee', dto: 'AddAssigneeDto', names: ['assigneeType', 'assigneeId'] },
    { tool: 'add_task_reviewer', dto: 'AddReviewerDto', names: ['reviewerType', 'reviewerId'] },
    { tool: 'add_task_approver', dto: 'AddApproverDto', names: ['approverType', 'approverId'] },
    {
        tool: 'create_kb_document',
        dto: 'CreateKbDocumentDto',
        names: ['path', 'title', 'class', 'body'],
        notNamed: ['content'],
    },
    {
        tool: 'update_kb_document',
        dto: 'UpdateKbDocumentDto',
        names: ['body'],
        notNamed: ['content'],
    },
    { tool: 'create_kb_tag', dto: 'CreateKbTagDto', names: ['slug', 'name'] },
    {
        tool: 'create_agent',
        dto: 'CreateAgentDto',
        names: ['scope', 'name', 'aiProviderId', 'modelId', 'missionId', 'ideaId', 'workId'],
        notNamed: ['scopeId', 'aiProvider', 'model'],
    },
    {
        tool: 'update_agent',
        dto: 'UpdateAgentDto',
        names: ['modelId', 'avatarMode', 'avatarIcon'],
        notNamed: ['model', 'avatar'],
    },
    {
        tool: 'create_skill',
        dto: 'CreateSkillDto',
        names: ['ownerType', 'ownerId', 'title', 'description', 'instructionsMd'],
        notNamed: ['name', 'definition'],
    },
    {
        tool: 'update_skill',
        dto: 'UpdateSkillDto',
        names: ['title', 'instructionsMd'],
        notNamed: ['definition'],
    },
    {
        tool: 'install_skill',
        dto: 'InstallCatalogSkillDto',
        names: ['slug', 'ownerType', 'ownerId'],
    },
    {
        tool: 'create_skill_binding',
        dto: 'CreateSkillBindingDto',
        names: ['targetType', 'targetId'],
        notNamed: ['agentId'],
    },
    {
        tool: 'create_notification_channel',
        dto: 'CreateChannelDto',
        names: ['pluginId', 'name', 'targetConfig'],
        notNamed: ['type', 'config'],
    },
    {
        tool: 'update_notification_channel',
        dto: 'UpdateChannelDto',
        names: ['targetConfig', 'disabled'],
        notNamed: ['config', 'enabled'],
    },
    { tool: 'create_api_key', dto: 'CreateApiKeyDto', names: ['name'], notNamed: ['scopes'] },
    {
        tool: 'add_work_member',
        dto: 'InviteMemberDto',
        names: ['email', 'role'],
        notNamed: ['userId'],
    },
    {
        tool: 'create_work_budget',
        dto: 'CreateBudgetDto',
        names: ['scope', 'monthlyCapCents'],
        notNamed: ['cap', 'overageBehaviour'],
    },
    {
        tool: 'update_work_budget',
        dto: 'UpdateBudgetDto',
        names: ['monthlyCapCents', 'allowOverage'],
        notNamed: ['cap', 'overageBehaviour'],
    },
    {
        tool: 'create_webhook',
        dto: 'CreateWebhookSubscriptionDto',
        names: ['url'],
        notNamed: ['secret'],
    },
    {
        tool: 'update_webhook',
        dto: 'UpdateWebhookSubscriptionDto',
        names: ['status', 'organizationIds', 'excludeOriginTags'],
        notNamed: ['enabled'],
    },
    {
        tool: 'update_organization',
        dto: 'UpdateOrganizationDto',
        names: ['displayName'],
        notNamed: ['slug', 'settings'],
    },
    {
        tool: 'create_custom_template',
        dto: 'AddCustomTemplateDto',
        names: ['kind', 'repositoryUrl'],
        notNamed: ['baseTemplateId', 'settings'],
    },
    { tool: 'set_default_template', dto: 'SetDefaultTemplateDto', names: ['kind', 'templateId'] },
    { tool: 'fork_template', dto: 'ForkTemplateDto', names: ['kind', 'templateId', 'targetOwner'] },
    {
        tool: 'update_custom_template',
        dto: 'UpdateCustomTemplateDto',
        names: ['kind'],
        notNamed: ['settings'],
    },
    { tool: 'generate_work_details', dto: 'GenerateWorkDetailDto', names: ['work_name', 'prompt'] },
    { tool: 'analyze_repository_for_linking', dto: 'AnalyzeRepositoryDto', names: ['sourceUrl'] },
    {
        tool: 'set_event_subscription',
        dto: 'SetEventSubscriptionBody',
        names: ['channelIds'],
        notNamed: ['enabled', 'channels'],
    },
];

/** Field-name tokens of a hint: identifiers, `[]` stripped (quoted enum values excluded). */
function hintTokens(hint: string): Set<string> {
    const withoutQuoted = hint.replace(/"[^"]*"/g, ' ');
    return new Set(withoutQuoted.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

describe('generated chat tools name the fields their API DTO accepts', () => {
    const byName = new Map(ALL_OPERATIONS.map((op) => [op.toolName, op]));

    it.each(CASES)('$tool → $dto', ({ tool, names, notNamed }) => {
        const op = byName.get(tool);
        expect(op, `${tool} is registered`).toBeDefined();
        expect(op!.body).toBe(true);
        const tokens = hintTokens(op!.bodyHint ?? '');
        for (const name of names) {
            expect(tokens.has(name), `${tool} hint names "${name}"`).toBe(true);
        }
        for (const name of notNamed ?? []) {
            expect(tokens.has(name), `${tool} hint no longer names "${name}"`).toBe(false);
        }
    });

    it('tells the model that create_work_upload cannot take a file from chat', () => {
        expect(byName.get('create_work_upload')?.bodyHint).toMatch(/NOT usable from chat/);
    });

    // `CreateAgentDto` / `UpdateAgentDto` declare `capabilities` as ONE string
    // (`@IsString() @MaxLength(5000)`): a hint saying `capabilities[]` makes the
    // model send an array and get 400 "capabilities must be a string".
    it.each(['create_agent', 'update_agent'])(
        '%s types capabilities as one free-text string, not an array',
        (tool) => {
            const hint = byName.get(tool)?.bodyHint ?? '';
            expect(hint).not.toMatch(/\bcapabilities\s*\[\]/);
            expect(hint).toMatch(/\bcapabilities \(free text, one string\)/);
        },
    );
});

describe('template tools need the user’s confirmation on every call', () => {
    // Prompt-injection hardening: once the hints named `kind`, these calls
    // stopped being 400s, so an injected tool result could add an attacker's
    // repository as a template, make it the default, or fork into the user's
    // GitHub — all without a card.
    it.each([
        'create_custom_template',
        'set_default_template',
        'fork_template',
        'update_custom_template',
        'customize_template',
        'customize_template_from_base',
        'switch_website_template',
    ])('%s is always gated as privileged', (tool) => {
        const op = ALL_OPERATIONS.find((o) => o.toolName === tool);
        expect(op, tool).toBeDefined();
        expect(op?.requiresConfirmation).toBe(true);
        expect(op?.confirmationKind).toBe('privileged');
    });
});

describe('addsAgentToTask — putting an Agent on a Task asks, like agentId on update_task', () => {
    it.each([
        ['add_task_assignee', 'assigneeType', 'assigneeId'],
        ['add_task_reviewer', 'reviewerType', 'reviewerId'],
        ['add_task_approver', 'approverType', 'approverId'],
    ])('%s asks before adding an agent, not before adding a person', (tool, typeField, idField) => {
        const op = ALL_OPERATIONS.find((o) => o.toolName === tool);
        expect(op?.confirmWhen).toBe(addsAgentToTask);
        expect(op?.confirmationKind).toBe('privileged');
        const confirmWhen = op!.confirmWhen!;
        expect(confirmWhen({ id: 't1', body: { [typeField]: 'agent', [idField]: 'a1' } })).toBe(
            true,
        );
        expect(confirmWhen({ id: 't1', body: { [typeField]: 'user', [idField]: 'u1' } })).toBe(
            false,
        );
    });

    it('fails closed on any actor type other than "user"', () => {
        expect(addsAgentToTask({ body: { assigneeType: 'Agent', assigneeId: 'a1' } })).toBe(true);
        expect(addsAgentToTask({ body: { reviewerType: null, reviewerId: 'a1' } })).toBe(true);
        expect(addsAgentToTask({ body: {} })).toBe(false);
        expect(addsAgentToTask({})).toBe(false);
    });
});

describe('redirectsWebhook', () => {
    it('asks when the call resumes a paused webhook (status "active")', () => {
        expect(redirectsWebhook({ id: 'w1', body: { status: 'active' } })).toBe(true);
        // Fails closed on anything that is not a pause.
        expect(redirectsWebhook({ id: 'w1', body: { status: 'ACTIVE' } })).toBe(true);
    });

    it('still asks when the call changes url, events or secret', () => {
        expect(redirectsWebhook({ id: 'w1', body: { url: 'https://x.example' } })).toBe(true);
        expect(redirectsWebhook({ id: 'w1', body: { events: ['*'] } })).toBe(true);
        expect(redirectsWebhook({ id: 'w1', body: { secret: 's' } })).toBe(true);
    });

    it('does not ask for a pause or a description change', () => {
        expect(redirectsWebhook({ id: 'w1', body: { status: 'paused' } })).toBe(false);
        expect(redirectsWebhook({ id: 'w1', body: { description: 'ops' } })).toBe(false);
        expect(redirectsWebhook({ id: 'w1', body: { description: 'ops', status: 'paused' } })).toBe(
            false,
        );
    });

    it('asks when the call widens which events it ships out (organizationIds / excludeOriginTags)', () => {
        expect(
            redirectsWebhook({
                id: 'w1',
                body: { organizationIds: ['00000000-0000-4000-8000-000000000001'] },
            }),
        ).toBe(true);
        expect(redirectsWebhook({ id: 'w1', body: { excludeOriginTags: [] } })).toBe(true);
    });

    it('asks for any field it does not know (allowlist, fails closed)', () => {
        expect(redirectsWebhook({ id: 'w1', body: { headers: { 'x-a': '1' } } })).toBe(true);
        expect(redirectsWebhook({ id: 'w1', body: { description: 'ops', workId: 'w-2' } })).toBe(
            true,
        );
    });
});

describe('redirectsNotificationChannel', () => {
    it('asks for confirmation when the call changes targetConfig — the API field name', () => {
        expect(
            redirectsNotificationChannel({ id: 'c1', body: { targetConfig: { url: 'x' } } }),
        ).toBe(true);
    });

    it('asks when the call changes the channel plugin, or uses the old config name', () => {
        expect(redirectsNotificationChannel({ id: 'c1', body: { pluginId: 'slack' } })).toBe(true);
        expect(redirectsNotificationChannel({ id: 'c1', body: { config: {} } })).toBe(true);
    });

    it('asks when the call re-enables a disabled channel', () => {
        expect(redirectsNotificationChannel({ id: 'c1', body: { disabled: false } })).toBe(true);
        // Fails closed on anything that is not a plain `true`.
        expect(redirectsNotificationChannel({ id: 'c1', body: { disabled: 'false' } })).toBe(true);
    });

    it('does not ask for a rename or a pause', () => {
        expect(redirectsNotificationChannel({ id: 'c1', body: { name: 'Ops' } })).toBe(false);
        expect(redirectsNotificationChannel({ id: 'c1', body: { disabled: true } })).toBe(false);
    });
});
