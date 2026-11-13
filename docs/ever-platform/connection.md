# Connecting Ever Works to Ever Platform

A self-hosted Ever Works installation can be connected to Ever Platform
(app.ever.co). An organization on Ever Platform can then turn on integrations
for it: today, **Sign in with Ever ID** through the installation's own sign-in
client, the answers to **people's export and deletion requests**, and
**install requests from apps.ever.co** (a plugin an organization owner picked,
installed only once a platform admin approves it: see
[Install requests from apps.ever.co](./install-requests.md)).

Four more parts can be switched on, each on its own and each off by default:
[linking an Organization](#linking-an-organization) to its organization on Ever
Platform with a link code, a daily [heartbeat](#heartbeat), reading the
[entitlement documents](#entitlement-documents), and listing an Organization's
[apps on Ever Platform](#apps-on-ever-platform).

The connection is off by default and nothing is sent until you connect.

## Turning it on

| Variable                       | Default               | Meaning                                                                                                          |
| ------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `EVER_CONNECT_ENABLED`         | unset (off)           | `true` loads the module. Unset or anything else: no route, no timer, no request.                                 |
| `EVER_CONNECT_CODE`            | unset                 | A connect code from app.ever.co (`EVC-XXXX-XXXX-XXXX`), used once at the first start that sees it.               |
| `EVER_CONNECT_FEED_MODE`       | `longpoll`            | How the event feed is read: `longpoll` (an open request of up to 25 seconds) or `interval` (every 15 minutes).   |
| `EVER_PLATFORM_API_URL`        | `https://api.ever.co` | The Ever Platform API. `https` only (plain `http` only for a local or private address, such as a test platform). |
| `PLUGIN_SECRET_ENCRYPTION_KEY` | unset                 | When set, the connect key and the Ever ID sign-in client are stored encrypted. Set it in production.             |

Each of the following needs `EVER_CONNECT_ENABLED=true` as well, is off unless
it is exactly `true`, and does nothing while the installation is not connected:

| Variable                            | Default     | Meaning                                                                                                                                |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `EVER_CONNECT_LINK_CODES_ENABLED`   | unset (off) | An Organization's administrator can link it to an organization on Ever Platform with a link code. Off: the link routes answer `404`.   |
| `EVER_CONNECT_HEARTBEAT_ENABLED`    | unset (off) | The installation tells Ever Platform that it is running, with its version, shortly after a start and then once a day.                  |
| `EVER_CONNECT_ENTITLEMENTS_ENABLED` | unset (off) | The signed entitlement documents are read, verified, kept and shown in Settings.                                                       |
| `EVER_CONNECT_APP_SYNC_ENABLED`     | unset (off) | The apps mirror: for an Organization that enabled it in app.ever.co, the identifiers and status of its Works and deployments are sent. |

## Connecting in Settings

A platform administrator connects in **Settings → Ever Platform**: create a
connect code for Ever Works in your organization on app.ever.co, paste it into
**Connect code** and choose **Connect**. The same section shows where the
connection stands (not connected, waiting for approval, connected, revoked),
the installation's ID on Ever Platform, and **Disconnect**, which asks for a
confirmation first. The code is used once and is not kept in the page.

A platform administrator can also connect and manage the connection through the
API (each route needs a platform administrator; the ones that change something
also need an interactive session, not an API key):

| Route                                                          | What it does                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ever-connect/status`                                 | The connection, the integrations, the Ever ID client and the outbox; and, for the parts switched on: the last heartbeat, what the installation's entitlement says and where the apps mirror stands. |
| `POST /api/ever-connect/connect` `{code}`                      | Connect with a connect code.                                                                                                                                                                        |
| `POST /api/ever-connect/disconnect`                            | Disconnect (Ever Platform is told; the connection ends here in any case).                                                                                                                           |
| `POST /api/ever-connect/integrations/refresh`                  | Read the integration states from Ever Platform again.                                                                                                                                               |
| `POST /api/ever-connect/integrations/:key/accept` `{accepted}` | Accept or decline an installation-wide integration enabled in app.ever.co.                                                                                                                          |

The install-request routes (`/api/ever-connect/install-requests`) are described in
[Install requests from apps.ever.co](./install-requests.md).

## What connecting does

- The installation makes a **connect key** (an Ed25519 key pair, different from
  the anonymous-statistics key) and sends its public half with the code. The
  private half never leaves the installation; it signs the short-lived requests
  for the installation's access token, which is kept in memory only.
- The installation then reads its **event feed** (one replica at a time) and
  learns which integrations an organization turned on.
- Every integration needs a consent given in app.ever.co. Installation-wide
  integrations, such as Sign in with Ever ID, also wait for a platform
  administrator of this installation to accept them.
- Disconnecting ends every integration here, removes the stored Ever ID client
  and discards the connect key (a new connection makes a new key).

## Linking an Organization

With `EVER_CONNECT_LINK_CODES_ENABLED=true`, an Organization here can be linked
to your organization on Ever Platform, so that both are known as the same
organization. A company created from Ever Platform is linked already; this is
for an Organization that existed before.

1. In app.ever.co, an owner or admin of the organization creates a **link code**
   for Ever Works (`EVL-XXXX-XXXX-XXXX`).
2. In Ever Works, an administrator of the Organization (see
   [who may change a link](#who-may-change-a-link)) opens **Settings → Ever
   Platform → Organization link**, pastes the code and chooses **Link**.

- **Sent:** the code, the account's (tenant's) ID and the Organization's slug.
  No other name, no e-mail address, no member, no content.
- **Received:** Ever Platform's ID of the link and of its organization. Its
  handle (`ever.co/<handle>`) is shown once the link's entitlement document was
  read.
- One Organization has one link, an account has one linked Organization, and
  an organization on Ever Platform is linked to one Organization of this
  installation.
- **Remove link** tells Ever Platform first. When it cannot be reached the link
  stays, so the two sides never disagree: try again, or remove the link in
  app.ever.co. A link removed in app.ever.co ends here within one read of the
  feed. Removing a link stops the integrations turned on for it; nothing in
  Ever Works is deleted. Disconnecting the installation ends its links.

| Route                                                | Who                                                       | What it does                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/ever-connect/organizations/:orgId/link`    | any member of the Organization's account                  | The link, what it has on Ever Platform, and whether the person asking may change it (`canManage`) |
| `POST /api/ever-connect/organizations/:orgId/link`   | an administrator of the Organization, interactive session | Link with a link code (`{code}`)                                                                  |
| `DELETE /api/ever-connect/organizations/:orgId/link` | an administrator of the Organization, interactive session | Remove the link                                                                                   |

An Organization of another account answers `404`, as on every
`/organizations/:orgId` route.

### Who may change a link

Linking an Organization and removing its link are for an **administrator of the
Organization** only:

- the owner of the account the Organization belongs to, or
- a member whose role in the Organization is `admin` or `owner`.

Any other member of the account is refused with `403`, in every configuration.
This does not depend on `ORG_ADMIN_ROLE_ENFORCED`: that setting decides whether
other Organization routes check the role, and the link routes always do, because
a link decides which organization on Ever Platform the Organization's apps may
be listed under.

Every member of the account can read the link. Settings shows it to them
without the form for a code and without **Remove link**, and says who can
change it.

## Heartbeat

With `EVER_CONNECT_HEARTBEAT_ENABLED=true`, a connected installation tells Ever
Platform that it is running: within a few minutes of a start, then once a day.

- **Sent:** the Ever Works version and the product name (`works`). Nothing else.
- Ever Platform shows when it last heard from the installation; the time of the
  last heartbeat is also shown to the platform administrator here.

## Entitlement documents

With `EVER_CONNECT_ENTITLEMENTS_ENABLED=true`, the installation reads the signed
documents that say what the account has on Ever Platform: the plan, the tier,
and which Ever Platform features and limits apply. There is one document for
the installation and one for each linked Organization.

- **Fetched:** every six hours (or as the document says), and when Ever Platform
  announces a new one. An unchanged document is not downloaded again.
- **Verified:** every document is checked with the Ever Platform SDK before it
  is kept: the signing key under Ever Platform's root key, the signature, that it
  was issued by the Ever Platform this installation is connected to, for this
  installation and for the expected subject, and that it is not older than the
  one already kept. A document that fails any check is not kept; the previous one
  stays, and Settings names the reason.
- **Kept:** as received, in the database (encrypted when
  `PLUGIN_SECRET_ENCRYPTION_KEY` is set), with the key set it was verified with.
- **Shown:** read-only in Settings → Ever Platform (the status, the plan, the
  features that are on, when it expires and when it was last read). The document
  itself is never shown.

Nothing in Ever Works depends on a document: only Ever Platform features do.
After a document expires its features still apply for a grace period.

## Apps on Ever Platform

With `EVER_CONNECT_APP_SYNC_ENABLED=true`, a linked Organization can list the
apps Ever Works builds for it on its **Apps** page in app.ever.co. An owner of
the organization enables **Apps and deployments** for the link there (a consent
given on Ever Platform); until then, and after it is switched off, nothing of a
Work is sent. Ever Works stays the source of truth: Ever Platform never writes
back.

**What is sent**, for each Work of the Organization:

- the Work's ID, its kind, its name, its slug and its status (draft, live,
  registered, archived), with the account's ID and the Organization's slug the
  link was made with;
- for its current deployment in each environment (production, preview): where
  it runs (the deploy target, the provider, the deploy shape and who manages
  it), its state, and its public address without credentials, query or
  fragment.

**What is never sent:** Work content or items, repositories or their addresses,
prompts, memory, agents, budgets, approvals, credits, environment values,
secrets, build logs, error messages, commits, branches, members or e-mail
addresses.

How it works:

- A change to a Work or to one of its deployments is noted in the outbox (the
  Work's ID only). The worker sends what is noted in batches, one for each link,
  every 30 seconds while there is something to send (up to 150 Works a round),
  with the Work as it is at that moment. Each operation carries a version that
  only grows, so sending one twice changes nothing.
- A Work that was deleted here is deleted on the Apps page.
- Once a day, and when the integration is enabled for a link, every Work of the
  Organization is sent again and compared with what Ever Platform holds. Nothing
  in Ever Works is ever changed or deleted by this.
- **Changes go first.** A Work that changed is sent before the Works of that
  daily full send, so a change reaches the Apps page in the next round even
  while a large installation is still sending its full list. A Work that
  already waits keeps its place when the full send starts.
- With several API replicas, one of them does this work at a time: it holds a
  two-minute lease and renews it between the steps of a round (before each
  batch and each page it reads). A replica that cannot renew stops at once; what
  it had not sent stays noted, and the replica that takes over sends it.
- A consent given for an earlier version of the integration, which did not list
  the name and the slug, moves nothing until the owner consents again.
- Switching the integration off, removing the link or disconnecting stops it at
  once and drops what was waiting (after a disconnect, also what Ever Platform
  had refused). Ever Platform then archives the apps it
  listed for the link.

The platform administrator sees in Settings → Ever Platform how many
Organizations have it enabled, how many Works wait to be sent, how many Ever
Platform refused (with the reason code), and when the full list was last sent.
Works waiting for the Apps page are counted there only: the outbox numbers of
the connection count the reports owed about people's Ever ID links.

Deploy targets are told in Ever Platform's open vocabulary:

| In Ever Works                                 | Target            | Provider     | Shape               | Managed by    |
| --------------------------------------------- | ----------------- | ------------ | ------------------- | ------------- |
| An App on your own cluster                    | `your-cluster`    | `k8s`        | `custom-kubeconfig` | `customer`    |
| An App on the shared apps cluster             | `ever-works-apps` | `k8s`        | `k8s-works-shared`  | `ever`        |
| A site on Ever Works hosting                  | `ever-works`      | `ever-works` | `k8s-works-shared`  | `ever`        |
| A site on Kubernetes with your own kubeconfig | `k8s`             | `k8s`        | `custom-kubeconfig` | `customer`    |
| A site on Kubernetes on an Ever Works cluster | `k8s`             | `k8s`        | the cluster source  | `ever`        |
| A site deployed by any other deploy plugin    | the plugin's ID   | the same     | `provider-plugin`   | `third_party` |

## Sign in with Ever ID

When Sign in with Ever ID is enabled for the installation in app.ever.co and
accepted here, the installation asks Ever Platform for its own sign-in client:

- **Sent:** the sign-in return address `<WEB_URL>/api/auth/ever-id/callback` and
  the back-channel logout address `<WEB_URL>/api/auth/ever-id/backchannel-logout`
  (both on the web host; the web hands logout notices to the API).
- **Received:** the issuer, the client id and the client secret. The secret is
  handed over once; it is stored (encrypted when `PLUGIN_SECRET_ENCRYPTION_KEY`
  is set) and never shown or logged.

The Ever ID sign-in (Settings → Ever ID) uses this client unless you configured
it yourself: any of `EVER_ID_ISSUER_URL`, `EVER_ID_CLIENT_ID` or
`EVER_ID_CLIENT_SECRET` keeps your own configuration. Turning Ever ID sign-in on
stays an administrator's step. When the integration ends (turned off or revoked
in app.ever.co, or the installation disconnects), the stored client is removed;
local accounts and their connected identities stay.

**Which accounts are linked:** when someone connects an Ever ID (at sign-up or
in Settings), signs in with it, or disconnects it, the installation tells Ever
Platform: the local account id, the Ever ID issuer and subject, that the person
linked it, and the account's tenant id. Never an e-mail address or a name. Ever
Platform records a link only for someone who signed in through this
installation's own client, so an Ever ID connected before the client existed is
reported at that person's next sign-in.

## People's export and deletion requests

When a person asks Ever Platform to export or delete their Ever ID data, each
connected installation that holds a link to them receives the request on its
feed. The request names the person only by hashes of their Ever ID identities.
The installation answers once per request:

- **Deletion:** the matching connected identities (and the sessions they
  opened) are removed. The accounts themselves are not deleted automatically
  yet, so the answer is `failed` with the reason `account_deletion_pending` and
  the account's Activity records it; delete the account here (Settings → Danger
  Zone) to finish. No matching account: `no_account`.
- **Export:** the answer is `failed` with `export_not_available` until a
  per-person export is wired in; the person can export their account here
  (Settings). No matching account: `no_account`.

An answer is never `retained_legal` without a stated legal basis, and a request
delivered again is answered with the same result.

## `/.well-known/ever-connect`

While the module is loaded, `GET /.well-known/ever-connect` answers `404`. It is
reserved for the statement Ever Platform reads while it checks an
installation's published address; that check is not active yet.

## Outbound calls

Every request goes to `EVER_PLATFORM_API_URL`, with the installation's token:

| When                                                            | Request                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect                                                         | `POST /v1/connect/redeem`                                                                                                                                                                         |
| Each request (token, every hour)                                | `POST /v1/instances/token`                                                                                                                                                                        |
| Reading the feed                                                | `GET /v1/instances/me/events`, `POST /v1/instances/me/events/ack`                                                                                                                                 |
| Integration states                                              | `GET /v1/instances/me/integrations`, `POST /v1/instances/me/integrations/{key}/accept`                                                                                                            |
| Sign in with Ever ID                                            | `POST` / `GET /v1/instances/me/oidc-client`                                                                                                                                                       |
| Linked accounts                                                 | `POST /v1/instances/me/person-links`, `DELETE /v1/instances/me/person-links/{ref}`                                                                                                                |
| Answers to requests                                             | `POST /v1/instances/me/ack`                                                                                                                                                                       |
| Disconnect                                                      | `POST /v1/instances/me/disconnect`                                                                                                                                                                |
| Install requests (when enabled)                                 | `POST /v1/installs/{install}/status`, after a platform admin answered a request                                                                                                                   |
| Linking an Organization (when switched on)                      | `POST /v1/instances/me/tenant-links`, `DELETE /v1/instances/me/tenant-links/{link}`, when an admin links or removes a link                                                                        |
| Heartbeat (when switched on)                                    | `POST /v1/instances/me/heartbeat`, after a start and once a day                                                                                                                                   |
| Entitlement documents (when switched on)                        | `GET /v1/instances/me/entitlement`, `GET /v1/instances/me/tenant-links/{link}/entitlement`, `GET /.well-known/ever-keys.json` (the key set), every six hours and when a new document is announced |
| Apps on Ever Platform (when switched on and enabled for a link) | `POST /v1/instances/me/mirror/apps` while Works wait to be sent, `GET /v1/instances/me/mirror/apps` once a day                                                                                    |

With none of the four switches on, the calls above the "Linking an Organization"
row are all there is.

## Creating a company from Ever Platform

Off by default (`EVER_CONNECT_PROVISIONING_ENABLED`, and `EVER_CONNECT_PROVISION_STAFFING_ENABLED` for starter staff and the first Mission). A person who starts a company on app.ever.co and chooses Ever Works arrives at `/ever-connect/provision` with a signed request in the URL fragment, signs in with Ever ID and confirms once. Works then creates the Company Work, the Organization (slug = the Ever handle, or `handle-2` when it is taken) and its link, and tells Ever Platform (`POST /v1/provision-intents/{jti}/complete`: the tenant, the Organization's slug, the owner's account id and the company's address; no name, no e-mail), retrying within a day.

The same request again answers the same company. A stopped creation is finished by its retry, also under a new request for the same step. A failed staffing or Mission step leaves the company in place (`partial`). Requests are kept until a day after they end, records 30 days.
