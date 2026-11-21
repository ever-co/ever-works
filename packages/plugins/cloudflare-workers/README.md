# @ever-works/cloudflare-workers-plugin

Cloudflare Workers deployment plugin for Ever Works: hosts static directory websites on
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

## Plugin metadata

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| ID           | `cloudflare`                          |
| Category     | `deployment`                          |
| Capabilities | `deployment`                          |
| Author       | Ever Works Team                       |
| License      | AGPL-3.0                              |
| Built-in     | yes (`distribution: core`)            |
| Auto-enable  | yes (not the default deploy provider) |

## How it works

One assets-only Worker per Work, named `<workerPrefix><subdomain>` (`ew-crm`), attached to
`<subdomain>.<zone>` (`crm.ever.works`) as a Workers Custom Domain. The plugin does not build anything:

1. The deploy service pushes `CLOUDFLARE_TOKEN` / `DEPLOY_TOKEN` and the secrets from
   `getDeploymentSecrets()` (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`, `CLOUDFLARE_HOSTNAME`) to the
   website repository.
2. It dispatches `deploy_cloudflare.yaml` (shipped by `ever-works/directory-web-minimal-template`), which
   builds the static site and runs `wrangler deploy`.
3. The deployment verifier polls `lookupExistingDeployment()`: no Worker → not found yet; Worker without its
   hostname → `BUILDING`; Worker with its hostname → `READY` at `https://<hostname>`.

The subdomain is the Work's managed subdomain (allocated collision-free by the platform), or the Work slug
without a leading `awesome-`.

## Settings

| Setting        | Scope | Notes                                                          |
| -------------- | ----- | -------------------------------------------------------------- |
| `apiToken`     | user  | Secret, required. Falls back to `CLOUDFLARE_DEPLOY_API_TOKEN`. |
| `accountId`    | user  | 32-character account id. Required with your own token.         |
| `zoneName`     | user  | Default `ever.works`. Must be a zone of the same account.      |
| `workerPrefix` | user  | Default `ew-`.                                                 |

Platform-managed mode (the operator's account) is configured only through env vars:
`CLOUDFLARE_DEPLOY_API_TOKEN`, `CLOUDFLARE_DEPLOY_ACCOUNT_ID`, `CLOUDFLARE_DEPLOY_ZONE_NAME` (default
`ever.works`). With the operator's token the member's account, zone and prefix are ignored, custom domains
cannot be added or removed, and the platform only deploys website repositories in the Ever Works GitHub
organisations.

Token permissions: Account → Workers Scripts: Edit; Zone → Workers Routes: Edit, DNS: Edit, Zone: Read.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/cloudflare-workers-plugin build
pnpm --filter @ever-works/cloudflare-workers-plugin test
```
