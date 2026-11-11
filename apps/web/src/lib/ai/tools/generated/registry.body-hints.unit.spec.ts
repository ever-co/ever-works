import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from './registry.all';
import { redirectsNotificationChannel } from './privileged';

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
        names: ['status'],
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

    it('does not ask for a rename or a pause', () => {
        expect(redirectsNotificationChannel({ id: 'c1', body: { name: 'Ops' } })).toBe(false);
        expect(redirectsNotificationChannel({ id: 'c1', body: { disabled: true } })).toBe(false);
    });
});
