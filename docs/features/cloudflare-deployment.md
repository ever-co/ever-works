---
id: cloudflare-deployment
title: Cloudflare Workers Deployment
sidebar_label: Cloudflare Workers Deployment
sidebar_position: 13
description: Host a static directory website on Cloudflare Workers Static Assets, one Worker per Work, served at <subdomain>.ever.works or under your own Cloudflare zone.
---

# Cloudflare Workers Deployment

The **Cloudflare Workers** deploy provider (plugin id `cloudflare`) hosts a Work's website as a fully static site on [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/). Each Work gets one assets-only Worker named `ew-<subdomain>` (for example `ew-crm`), attached to `<subdomain>.<zone>` (for example `crm.ever.works`) as a [Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Cloudflare creates the DNS record and the TLS certificate.

:::tip When to use this
Use it for directory websites built from the static **minimal** template (`ever-works/directory-web-minimal-template`), which builds to plain HTML with no server runtime. Pick [Vercel](../plugin-system/vercel-plugin.md) or [Kubernetes](./k8s-deployment.md) for a site that needs server-side rendering or API routes.
:::

## How it works

1. **Deploy** — when you deploy the Work, Ever Works writes these repository secrets to the Work's website repository:

    | Secret                                  | Value                                            |
    | --------------------------------------- | ------------------------------------------------ |
    | `CLOUDFLARE_TOKEN` (and `DEPLOY_TOKEN`) | the Cloudflare API token                         |
    | `CLOUDFLARE_ACCOUNT_ID`                 | the Cloudflare account that hosts the Worker     |
    | `CLOUDFLARE_WORKER_NAME`                | `<prefix><subdomain>`, e.g. `ew-crm`             |
    | `CLOUDFLARE_HOSTNAME`                   | `<subdomain>.<zone>`, e.g. `crm.ever.works`      |
    | `DATA_REPOSITORY`, `GH_TOKEN`, …        | the same build inputs every deploy provider gets |

2. **Build** — Ever Works starts the repository's `deploy_cloudflare.yaml` GitHub Actions workflow. It builds the site as static files and runs `wrangler deploy`, which uploads the files to the Worker and attaches the hostname.
3. **Status** — Ever Works polls Cloudflare: while the Worker does not exist yet the build is still running; once the Worker is deployed and its hostname is attached, the deployment is **Ready** and the Work's website is `https://<subdomain>.<zone>`. A first deploy is given the full 13-minute budget, because the Worker only appears at the very end of the build.
4. **Redeploy** — each deploy uploads a new version of the same Worker.

### The subdomain

The hostname label is the Work's **managed subdomain**. On the first deploy Ever Works allocates one from the Work slug with a leading `awesome-` removed (`awesome-crm` → `crm`), adds a short suffix if another Work already holds that label, and stores it on the Work, so a slug rename never moves the site. You can change it on the Work's **Deploy** tab; the new hostname goes live on the next deploy, on a new `ew-<subdomain>` Worker. The old Worker keeps serving the old hostname until it is removed in Cloudflare.

## Configure the provider

Open **Settings → Plugins → Deployment**, find **Cloudflare Workers** and click **Configure**.

| Field                     | Required                                   | Notes                                                                                                  |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Cloudflare API token**  | yes (unless the platform hosts your sites) | A scoped token, see the permissions below. Stored encrypted.                                           |
| **Cloudflare account ID** | with your own token                        | The 32-character account ID shown in the Cloudflare dashboard.                                         |
| **Zone**                  | no                                         | Defaults to `ever.works`. With your own account, set it to a zone of that account, e.g. `example.com`. |
| **Worker name prefix**    | no                                         | Defaults to `ew-`.                                                                                     |

**Validate** checks the token on the account (`/accounts/{id}/tokens/verify`, which is the endpoint that accepts account-owned tokens), that the token can read the account's Workers, and that the zone is in the account.

### Token permissions

Create the token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with:

- **Account → Workers Scripts: Edit**
- **Zone → Workers Routes: Edit**, **Zone → DNS: Edit** and **Zone → Zone: Read**, on the zone your sites are published under

### Pick the provider for a Work

Set the Work's deploy provider to `cloudflare` (in the Create-Work form or the Work's Deploy settings, or `deployProvider: cloudflare` through the API), then deploy. The website repository must contain `.github/workflows/deploy_cloudflare.yaml`, which the minimal template ships.

## Platform-hosted sites

An operator can host sites on the platform's own Cloudflare account, so members configure nothing. Set these environment variables on the API:

| Variable                       | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `CLOUDFLARE_DEPLOY_API_TOKEN`  | the platform's Cloudflare API token (fallback for the member token) |
| `CLOUDFLARE_DEPLOY_ACCOUNT_ID` | the platform's Cloudflare account ID                                |
| `CLOUDFLARE_DEPLOY_ZONE_NAME`  | the zone sites are published under (default `ever.works`)           |

A member's own token always wins over the platform token. With the platform token:

- the account, zone and Worker prefix are always the operator's (`ew-`); a member's own values are ignored, so a member can never point the platform token at another zone of the platform account or at a Worker that is not a Work's;
- the platform only deploys websites whose repository is in an Ever Works GitHub organisation (`ever-works`, `ever-works-cloud`), because the token is written to the repository as a secret and anyone who can push a workflow to a repository can read its secrets. A Work whose website repository is in another organisation is refused with a message asking for the member's own token;
- extra custom domains cannot be added or removed.

Once `CLOUDFLARE_DEPLOY_API_TOKEN` is set, the provider counts as configured for every member, so it can become the preselected provider on the Create-Work form.

Keep Workers that are not Work sites out of the `ew-` name space on the platform account: a Work with the subdomain `x` deploys to the Worker `ew-x`.

## Custom domains

With your own Cloudflare account, the Work's **Domains** panel adds, lists, verifies and removes Workers Custom Domains on the Work's Worker. The domain's zone must be on Cloudflare, in the same account. Cloudflare creates the DNS record and certificate, so there is nothing to verify by hand.

:::caution
`wrangler deploy` replaces a Worker's custom domains with the ones its configuration lists, and the template's workflow lists only the Work's hostname. A domain added from the Domains panel therefore stays attached only until the next deploy. Add it to the workflow's `routes` if it must survive redeploys.
:::

## Costs

Requests that only serve static assets are free and unlimited on every Workers plan: an assets-only Worker never runs code, so a directory site costs nothing to serve on the Free plan, whatever its traffic. Custom domains and their certificates are free. The limits that matter for a static site are the number of files per Worker version (20,000 on the Free plan, more on Workers Paid) and 25 MiB per file; the workflow warns when a build goes past 20,000 files. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Static Assets limits](https://developers.cloudflare.com/workers/static-assets/#limits).

## Troubleshooting

| Symptom                                                   | Likely cause                                                                | Fix                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workflow fails at **Check deploy configuration**          | a repository secret is missing (no account ID saved, or no token)           | Fill in the plugin settings and deploy again; the step names the missing secrets                  |
| `wrangler deploy` fails with an authentication error      | the token lacks a permission or belongs to another account                  | Re-create the token with the permissions above, on the account of **Cloudflare account ID**       |
| Deployment stays **Building**                             | the Worker deployed but the hostname could not be attached                  | Check the workflow log of the **Deploy to Cloudflare** step; the zone must be in the same account |
| "The platform's Cloudflare account only hosts websites …" | the platform token was about to be used for a repository outside Ever Works | Add your own token and account ID                                                                 |
| Deploy says the workflow is missing                       | the website repository has no `deploy_cloudflare.yaml`                      | Use the minimal template, or copy the workflow from it                                            |

## See also

- [Managed Hosting](./managed-hosting.md) — the managed `*.ever.works` subdomains
- [Custom Domains](./custom-domains.md)
- [Kubernetes Deployment](./k8s-deployment.md)
- [Deployment plugins](../plugin-system/deployment-plugins.md)
