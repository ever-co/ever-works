# Connecting Ever Works to Ever Platform

A self-hosted Ever Works installation can be connected to Ever Platform
(app.ever.co). An organization on Ever Platform can then turn on integrations
for it: today, **Sign in with Ever ID** through the installation's own sign-in
client, the answers to **people's export and deletion requests**, and
**install requests from apps.ever.co** (a plugin an organization owner picked,
installed only once a platform admin approves it: see
[Install requests from apps.ever.co](./install-requests.md)).

More parts can be switched on, each on its own and each off by default:
[linking an Organization](#linking-an-organization) to its organization on Ever
Platform with a link code, a daily [heartbeat](#heartbeat), reading the
[entitlement documents](#entitlement-documents), listing an Organization's
[apps on Ever Platform](#apps-on-ever-platform), letting another Ever app
[create and deploy an App for a person](#creating-and-deploying-an-app-for-a-person)
who allowed it, answering
[people's export and deletion requests](#answering-with-the-persons-data) with
their data, and applying the
[membership changes](#membership-changes-from-ever-platform) Ever Platform sends
for a linked Organization.

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

| Variable                                 | Default     | Meaning                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EVER_CONNECT_LINK_CODES_ENABLED`        | unset (off) | An Organization's administrator can link it to an organization on Ever Platform with a link code. Off: the link routes answer `404`.                                                                                                                                                                                           |
| `EVER_CONNECT_HEARTBEAT_ENABLED`         | unset (off) | The installation tells Ever Platform that it is running, with its version, shortly after a start and then once a day.                                                                                                                                                                                                          |
| `EVER_CONNECT_ENTITLEMENTS_ENABLED`      | unset (off) | The signed entitlement documents are read, verified, kept and shown in Settings.                                                                                                                                                                                                                                               |
| `EVER_CONNECT_APP_SYNC_ENABLED`          | unset (off) | The apps mirror: for an Organization that enabled it in app.ever.co, the identifiers and status of its Works and deployments are sent.                                                                                                                                                                                         |
| `EVER_CONNECT_APPS_WRITE_ENABLED`        | unset (off) | Another Ever app may create an App in a linked Organization, and start a deployment of one, for a person who allowed it there. **Requires a non-empty `EVER_ID_TRUSTED_CLIENT_IDS`** (the apps that may write): without it the switch does nothing. Off: the `/api/ever-connect/apps` routes answer `404`.                     |
| `EVER_CONNECT_PERSON_EXPORT_ENABLED`     | unset (off) | A person's export request is answered with an address where the person, signed in here, downloads what Ever Works holds about their own account (see [Answering with the person's data](#answering-with-the-persons-data)). Off: the answer stays `failed` with `export_not_available`.                                        |
| `EVER_CONNECT_PERSON_DELETION_ENABLED`   | unset (off) | A person's deletion request deletes the matching accounts, through the account deletion of Settings → Danger Zone, when that is safe for everyone else. **Irreversible.** Off: only the connected identities are removed and the answer stays `failed` with `account_deletion_pending`.                                        |
| `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED`   | unset (off) | The membership changes Ever Platform sends for a linked Organization are applied to its members (see [Membership changes from Ever Platform](#membership-changes-from-ever-platform)). Off: they are read past and nothing changes.                                                                                            |
| `EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED` | unset (off) | `POST /api/works` keeps the marketplace install a create request names, for an App made from a Blueprint in the Organization linked to the install's Ever organization. Off: an install in a create request is ignored and nothing is kept. The web app has a switch of the same name for reading the address that carries it. |

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
  fragment;
- for an App that was created from a Blueprint of the Apps catalog, where it
  comes from (`lineage`, below). Such an App is also told as based on one of
  Ever's own products (`base_kind: "ever"`) or on another open-source project
  (`base_kind: "oss"`); every other Work is `base_kind: "none"` and has no
  `lineage`.

```json
"lineage": {
  "provisioned_by": "blueprint",
  "blueprint": { "id": "<the Blueprint's ID in the Apps catalog>" },
  "install_id": "<Ever Platform's ID of the marketplace install>"
}
```

- `blueprint` is an **object**. Its `id` is text; a `version` (text) is part of
  the shape and is sent only when the Work records which version of the
  Blueprint it was created from, which it does not today.
- `provisioned_by` is the text `blueprint`.
- `install_id` (text) is there only when the App was created for a marketplace
  install (see
  [An App installed from the marketplace](#an-app-installed-from-the-marketplace)
  and
  [Creating and deploying an App for a person](#creating-and-deploying-an-app-for-a-person)).
  **It is a claim**: the ID a person's address, or the app acting for them,
  carried. Ever Platform decides whether it holds: that the install belongs to
  the same organization as the link the batch is sent under, that it is for the
  same Blueprint, and that it is not already bound to another App. Ever Works
  asserts none of that.

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
- A deployment of an App is noted when it starts, succeeds, fails or is rolled
  back, like a deployment of a site: its state reaches the Apps page in the next
  round, not at the next daily full send.
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

## An App installed from the marketplace

Off by default, behind **two switches of the same name**, one on each side:

| Where       | Variable                                      | What it turns on                                                                                                                                                                            |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The web app | `EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED=true` | `/new` and `/works/new` read the address below, and the create action lets an install travel on to the API.                                                                                 |
| The API     | `EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED=true` | `POST /api/works` reads the install a create request names and keeps it on the App (needs `EVER_CONNECT_ENABLED=true`). Off: an install in a create request is ignored and nothing is kept. |

Only the exact value `true` turns either on. With the web switch off the address
below is an ordinary visit to `/new`. With the API switch off no install id is
stored, whatever a request carries.

A person who installs a Blueprint listing on Ever Platform's marketplace is sent
to Ever Works to create the App, with an address like:

```
/new?type=app&blueprint=<blueprint id>&ever_org=<Ever organization>&install=<install id>
```

- `blueprint` is the Blueprint's ID in the Apps catalog; `install` is Ever
  Platform's ID of the install; `ever_org` is the Ever organization that
  installed it (its ID or its handle). Each is read only when it is spelled like
  one; an address without a `blueprint` is an ordinary visit to `/new`.
- A visitor who is not signed in signs in first and comes back to the same
  address: the three values are kept, and nothing else of the address is.
- The App create form opens on that Blueprint's repository, as this
  installation's Apps catalog names it, and checks it at once. When `ever_org`
  names an Ever organization that one of the person's Organizations is
  [linked](#linking-an-organization) to, a visitor in their personal workspace is
  taken to that Organization, so the App is created where its apps are listed.
  When the catalog here does not have the Blueprint, the form opens on the
  catalog and says so.

### The install ID is a claim

Anyone can write an address, so the install ID it carries proves nothing. It is
kept on the App only when all of this holds:

- the request creates an **App** from a **Blueprint** (the one the address
  named: choosing another repository in the form creates an ordinary App
  without it);
- it comes together with the Ever organization it belongs to (`ever_org`); an
  install without one binds nothing and is left out;
- the Organization the App is created in is **linked to that Ever
  organization** (an active link, by Ever Platform's ID of the organization or
  by its handle). The web form gets the install only when it is opened in that
  Organization, and the API checks it again on its own.

Everything else is **ignored, not refused**: a create request that carries an
install for a Work that is not an App, without a Blueprint, without `ever_org`,
with a value that is not spelled like an ID, or while the switch is off, creates
the Work exactly as a request without it does, and stores nothing. One case is
refused: a request that names an Ever organization and is made in an
Organization that is not linked to it answers
`409 { "code": "install_organization_mismatch" }`, and nothing is created.

On `POST /api/works` the two values are the optional fields `installId` and
`everOrg`. `everOrg` is used for that check only; it is not stored.

Ever Works asserts nothing more about the install. With the
[apps mirror](#apps-on-ever-platform) on and enabled for the Organization's
link, the ID is repeated to Ever Platform as `lineage.install_id`, and **Ever
Platform decides** whether it holds: that the install belongs to the same
organization as the link the batch is sent under, that it is for the same
Blueprint, and that it is not already bound to another App.

Nothing is sent to Ever Platform by the hand-off itself: the install's ID leaves
the installation only through the apps mirror, when that is on and enabled for
the Organization's link.

## Creating and deploying an App for a person

With `EVER_CONNECT_APPS_WRITE_ENABLED=true` **and a list of the apps that may
write** (`EVER_ID_TRUSTED_CLIENT_IDS`, at least one client ID), another Ever app
(such as app.ever.co) can create an App here, and start a deployment of one,
**for a person who allowed it there**. Off by default: unset, both routes below
answer `404`.

**The list is required.** A write changes things in a person's name (a
repository in their Git account, a deployment), so it is never open to every
client of the identity provider:

- with the switch on and `EVER_ID_TRUSTED_CLIENT_IDS` unset, empty or holding
  nothing that is a client ID, the routes **stay off** (`404`), and the API says
  why once at its start, as an error in its log;
- a token is accepted for a write only when it says which app it was issued to
  (`azp`) and that app is on the list. A token without `azp`, or issued to
  another app, is refused (`401`), and so is every write while the list is
  empty, whatever the token carries.

Reading for a person (the launcher list, scope `apps:read`) keeps its own rule:
without a list, any client whose token verifies may read.

The caller presents a short-lived Ever ID access token issued for that person,
for this installation's audience (`ever-works` unless `EVER_ID_API_AUDIENCE`
says otherwise), carrying the scope `apps:write` (`Authorization: Bearer
<token>`, never in the address). The token is checked as every delegated token
is (signature, issuer, audience, expiry, a lifetime of at most an hour), and it
must have been issued to one of the trusted apps. A token that may only read
(`apps:read`) is refused. Nothing else is admitted on these routes: not a
session, not an API key.

Both routes act **as the person**, and decide nothing about the App themselves:

- the request names the Organization by the ID of its link (`link_id`, as Ever
  Platform issued it); the installation must be connected and the link active;
- the person must be a member of that Organization's account, which is what lets
  them create a Work in it when they are signed in;
- the App is then created, or the deployment asked for, through the same path a
  signed-in person's own request takes. Whether App Works are on
  (`EVER_WORKS_APP_WORKS_ENABLED`), the person's connected GitHub account, what
  the repository allows, an App that already exists, the deploy preconditions:
  each is checked there and refuses with the code it always has.

Three more things hold for both:

- **A link is not confirmed to anyone outside it.** A person who is not a member
  of the Organization a link is for gets the answer of a link that does not
  exist (`404 link_not_found`), word for word, whether the link is active or was
  removed. Only a member is told that their link was removed
  (`409 link_not_active`).
- **Nothing starts on its own.** A create does not start the automatic work on
  the new App's repository (working out how to run it) unless the request says
  `"auto_provision": true`. A signed-in person's own create keeps its default.
- **What was done is written down.** Each App created and each deployment asked
  for this way leaves a row in the person's Activity, in the Organization, with
  the app that acted as the actor (its client ID) and the IDs of the link and of
  the App or the deployment. Nothing of the token is recorded.

A call made this way is **never the person's own session**. A deployment that
needs the Work owner at their own keyboard (the first deployment with a cluster
credential another member saved, a change of the cluster an App runs on) is
refused, and nothing is confirmed on anyone's behalf. The deployment is recorded
as asked for by the person (a manual deployment); which app asked is on the
Activity row.

### `POST /api/ever-connect/apps`

Creates an App from a Blueprint of this installation's Apps catalog.

|         |                                                                                           |
| ------- | ----------------------------------------------------------------------------------------- |
| Headers | `Authorization: Bearer <token with apps:write>`, `Idempotency-Key: <1 to 128 characters>` |
| `201`   | `{ "id": "<the App's ID here>", "name": "…", "url": "<the App's page in Ever Works>" }`   |
| `200`   | The same body, for an identical App the person already has                                |

The body is a JSON object of these fields and no other:

| Field            | Required | Value                                                                                                                               |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `link_id`        | yes      | The link's ID, as Ever Platform issued it (26 characters)                                                                           |
| `name`           | yes      | 1 to 100 characters of plain text                                                                                                   |
| `blueprint_id`   | yes      | The ID of a Blueprint of the Apps catalog here                                                                                      |
| `install_id`     | no       | Ever Platform's ID of the marketplace install the App is for (26 characters, upper case)                                            |
| `auto_provision` | no       | `true`: start the automatic work on the new App's repository at once, as a signed-in person's create does. Default `false`: do not. |

The repository is the one the catalog names for the Blueprint; it becomes the
App's own as the create form does it before a person changes anything (the mode
the repository offers by default, in the first account the person can create a
repository in). `install_id` is kept on the App, as a claim
([see above](#the-install-id-is-a-claim): it arrives with a link the person is a
member of, and Ever Platform decides whether it holds). `id` is the ID the
[apps mirror](#apps-on-ever-platform) reports the App under.

The same `Idempotency-Key` with the same body answers the App made before, with
the header `Idempotent-Replayed: true`, for 24 hours; a key belongs to the
person. A field left out, `null`, and for `auto_provision` also `false`, are the
same body. A refused request keeps nothing, so the same key can be sent again
once the cause is gone.

Every refusal is `{ "status": "error", "code": "…", "message": "…" }`:

| Status | `code`                                                               | When                                                                                                                                                                  |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `validation`                                                         | A header or a field is missing or not spelled as it must be (`details.field` names it); a field outside the five above                                                |
| `400`  | `token_in_query`                                                     | A token was sent in the address                                                                                                                                       |
| `400`  | `app_works_disabled`                                                 | App Works are off on this installation                                                                                                                                |
| `400`  | `provider_not_connected`                                             | The person has no connected GitHub account                                                                                                                            |
| `400`  | `target_owner_unavailable`, `not_found`, `blueprint_mismatch`, …     | The repository cannot become an App for this person: the code the create form shows for the same case                                                                 |
| `401`  | (none)                                                               | The token does not verify, names no app (`azp`), or was issued to an app that is not in `EVER_ID_TRUSTED_CLIENT_IDS`                                                  |
| `403`  | `insufficient_scope`                                                 | The token does not carry `apps:write`                                                                                                                                 |
| `403`  | `no_linked_identity`                                                 | The token is valid, but the person has no Ever ID connected to an account here                                                                                        |
| `403`  | `delegated_token_required`                                           | The caller is not a delegated token (a session, an API key)                                                                                                           |
| `404`  | (the answer of an unknown address)                                   | The routes are off: the switch is unset, or `EVER_ID_TRUSTED_CLIENT_IDS` names no app                                                                                 |
| `404`  | `link_not_found`                                                     | No link with this ID here, **or** the person is not a member of the Organization the link is for (the same answer, so a link's existence is told to its members only) |
| `404`  | `blueprint_not_found`                                                | The Apps catalog here does not have the Blueprint                                                                                                                     |
| `409`  | `not_connected`                                                      | The installation is not connected to Ever Platform                                                                                                                    |
| `409`  | `link_not_active`                                                    | The link was removed (told to a member of its Organization only)                                                                                                      |
| `409`  | `idempotency_key_reused_with_different_body`                         | The key was used with other values                                                                                                                                    |
| `409`  | `request_in_progress`                                                | A request with this key is still running                                                                                                                              |
| `409`  | `app_work_exists`, `create_in_progress`, `in_use_by_another_account` | The App, or its repository, already exists (`details.workId` names the person's own)                                                                                  |
| `422`  | `blueprint_required`                                                 | No `blueprint_id`: an App is started from a Blueprint                                                                                                                 |
| `422`  | `blueprint_not_available`                                            | The Blueprint is listed but cannot start an App yet                                                                                                                   |
| `422`  | `slug_unavailable`                                                   | No address could be made from the name                                                                                                                                |
| `503`  | `catalog_unavailable`                                                | The Apps catalog cannot be read right now                                                                                                                             |
| `503`  | `rate_limited`                                                       | GitHub is rate-limiting the person's account (`details.retryAfter`)                                                                                                   |

A refusal of the creation path that carries no code of its own is passed on
under its status with `create_refused`.

### `POST /api/ever-connect/apps/:workId/deploy`

Asks for a deployment of an App: the request of `POST /api/works/:id/deploy`,
with the same preconditions.

|         |                                                                                       |
| ------- | ------------------------------------------------------------------------------------- |
| Headers | `Authorization: Bearer <token with apps:write>`                                       |
| Body    | `{ "link_id": "<link ID>", "environment": "production" }` (`environment` is optional) |
| `202`   | `{ "deployment_id": "…", "status": "accepted" }`, or `"queued"` behind a running one  |

The App must be one of the Organization the link is for, and one the person may
change. Refusals:

| Status | `code`                                                                 | When                                                                                                      |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `400`  | `validation`, `token_in_query`                                         | As above; an App ID that is not one; `environment` other than `production`; a field outside the two above |
| `401`  | (none)                                                                 | As above                                                                                                  |
| `403`  | `insufficient_scope`, `no_linked_identity`, `delegated_token_required` | As above                                                                                                  |
| `403`  | `ownerRequired`                                                        | The deployment needs the Work owner, and the person is not the owner                                      |
| `403`  | `session_required`                                                     | The deployment needs the Work owner's own session: the owner deploys it once in Ever Works first          |
| `404`  | (the answer of an unknown address)                                     | The routes are off, as above                                                                              |
| `404`  | `link_not_found`                                                       | As above: no such link, or the person is not a member of its Organization                                 |
| `404`  | `not_found`                                                            | No such App for this person in this Organization                                                          |
| `409`  | `not_connected`, `link_not_active`                                     | As above                                                                                                  |
| `409`  | `APP_DEPLOY_IN_PROGRESS`                                               | Another deployment is running (`running_deployment_id`)                                                   |
| `422`  | `notAnAppWork`                                                         | The Work is not an App                                                                                    |
| `422`  | `APP_DEPLOY_PRECONDITIONS`                                             | A precondition is not met; `unmet` lists each with its own `code` and `message`                           |
| `422`  | `worker_not_isolated`                                                  | No isolated worker is available to run the deployment                                                     |

A refusal of the deploy service that carries no code of its own is passed on
with `deploy_refused`.

### Before switching it on

Connect the installation, switch on and use
[linking](#linking-an-organization), turn on App Works and Sign in with Ever ID,
and **list the apps that may write in `EVER_ID_TRUSTED_CLIENT_IDS`**: without
that list the switch does nothing. A person can be acted for only after they
connected their Ever ID to their account here, and only in an Organization they
are a member of.

### Before a second installation turns this on

The audience a delegated token must carry is `ever-works` on every installation
that does not set `EVER_ID_API_AUDIENCE`. With that default, a token issued so
that an app can act for a person at one installation also verifies at another
installation that trusts the same identity provider and lists the same app, when
that person has an account with a connected Ever ID there too. Nothing in the
token says which installation it is for.

With one installation this cannot happen. Before a second one switches this on:

- give each installation its own audience (`EVER_ID_API_AUDIENCE`), and have the
  identity provider issue the token for the audience of the installation it is
  meant for. Every delegated token, a write included, is already checked against
  that setting, so a token for another installation's audience is refused
  (`401`);
- a claim in the token that names the installation (its ID on Ever Platform),
  checked here on every write, is the planned hardening. It is not checked
  today.

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

### A link that starts the sign-in

Off by default, behind a switch on the web app:

| Where       | Variable                           | What it turns on                                                    |
| ----------- | ---------------------------------- | ------------------------------------------------------------------- |
| The web app | `EVER_ID_START_ROUTE_ENABLED=true` | The web app answers the address below. Off: the address is a `404`. |

With it on, another Ever app can link straight into the sign-in:

```
<WEB_URL>/api/auth/ever-id/start
<WEB_URL>/api/auth/ever-id/start?return=/works
```

- **What it is for.** A person who follows the link is not shown the sign-in
  page: the sign-in that the **Sign in with Ever ID** button starts begins at
  once, and after signing in at Ever ID they land where that sign-in always
  lands. A person who is already signed in goes straight there, and no sign-in
  is started. The address makes the same requests the button makes, and no
  others.
- **When it answers.** Only the exact value `true` turns it on, and only while
  **Sign in with Ever ID** is shown on the sign-in page (an administrator turned
  Ever ID on). In every other case the address answers `404`, like any address
  that does not exist, and nothing else changes. The switch needs no new build:
  restart the web app.
- **The return path.** `return` names where to land, and is used only when it is
  a path of this installation: it starts with a single `/`. An absolute URL,
  `//host`, a backslash, a control or invisible character, a `.` or `..`
  segment, a percent-encoded spelling of any of those (however many times it is
  encoded), a path of more than 512 characters and a `return` given twice are
  all refused. A refused value is ignored, not repaired: the person still signs
  in and lands on the normal page. The address can therefore not be used to
  send anyone to another site.
- **Only a link.** Only a person following a link starts a sign-in. A page that
  loads the address in the background (an image, a frame, a script request, a
  prefetch) gets a `404` and starts nothing. The limit on starting a sign-in is
  the button's own; a sign-in that cannot start lands on the sign-in error page.

## People's export and deletion requests

When a person asks Ever Platform to export or delete their Ever ID data, each
connected installation that holds a link to them receives the request on its
feed. The request names the person only by hashes of their Ever ID identities.
The installation answers once per request. The accounts concerned are the ones
whose connected identity matches one of those hashes, and no other.

- **Deletion:** the matching connected identities (and the sessions they
  opened) are removed. By default the accounts themselves are not deleted, so
  the answer is `failed` with the reason `account_deletion_pending` and the
  account's Activity records it; delete the account here (Settings → Danger
  Zone) to finish. No matching account: `no_account`.
- **Export:** by default the answer is `failed` with `export_not_available`;
  the person can export their account here (Settings). No matching account:
  `no_account`.

An answer is never `retained_legal` without a stated legal basis, and a request
delivered again is answered with the same result.

### Answering with the person's data

Two switches, each off by default and each on its own, make these answers final:

- **`EVER_CONNECT_PERSON_EXPORT_ENABLED`:** the answer is `exported`, with the
  address `<WEB_URL>/api/ever-connect/person-export/<job>` (`WEB_URL` must be
  `https`; Ever Platform keeps the address and shows it to the person, it never
  opens it). Nothing is prepared or stored. A person who opens the address is
  asked to sign in here, then downloads a JSON document
  (`ever-works.person-data`, version 1) built at that moment by
  `GET /api/ever-connect/person-exports/:jobId`, which needs an interactive
  session (an API key is refused) and always answers **the signed-in account's
  own data**, whoever holds the address. It holds the account's profile, its
  connected identities, its workspaces and their Organizations with the
  person's own role in each, the Works and Apps the account owns or is a member
  of, its notification and onboarding settings, the plugins it turned on and its
  API keys by name. Never another member, a password, a token, a key or a
  plugin's settings. The address works for 30 days after the answer; otherwise,
  and while the switch is off, it answers `404`.
- **`EVER_CONNECT_PERSON_DELETION_ENABLED`:** the accounts are deleted by the
  same deletion as Settings → Danger Zone (the audit record names Ever Platform
  as its source, and the account's address gets the same "account deleted"
  e-mail), and the answer is `deleted`. A workspace the account owns with other
  people in it is handed to the longest-standing admin (else member), with what
  the account created there; in somebody else's workspace, the account's
  membership goes and what it created there stays with the workspace; only a
  workspace the account is alone in goes with it. **Every account is checked
  first, and none is deleted** (the answer stays `failed` with
  `account_deletion_pending`) when one of them is an installation
  administrator, or would take with it a workspace that still has other people
  in it or that holds an Organization linked to Ever Platform: such an account
  is deleted here by the person, in Settings → Danger Zone. **A deletion cannot
  be undone.**

Neither switch makes a call to Ever Platform beyond the answer itself.

## Membership changes from Ever Platform

With `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED=true`, the membership changes Ever
Platform sends on the installation's feed for an organization linked to an
Organization here (`ever.registry.membership.created`, `.role_changed` and
`.removed`) are applied to that Organization's members:

- **Who:** the one account whose connected Ever ID has the identity the change
  names (and, when the change also names the local account, that account). A
  person with no account here, or a link that is not active, changes nothing:
  no account is ever created.
- **Roles:** Ever `owner` and `admin` become `admin` here, `member` stays
  `member`. The owner of the account the Organization belongs to is never
  changed or removed, so an Organization never loses its owner. Any other role
  changes nothing.
- **Added:** the person joins the Organization with that role, as an accepted
  invitation makes them join (a free seat is needed). A person whose account
  already belongs to another account here is never moved.
- **Role changed:** the role of a member is set; it adds nobody.
- **Removed:** the person leaves the Organization, as when an administrator
  removes them; nothing they made is deleted.
- **Order and repeats:** the last change applied for a person in an
  Organization is kept, so the same change delivered again does nothing and a
  change older than it (by its time, then its id) is skipped.

Each change is logged by a code only, never with an identity or a name. It makes
no call to Ever Platform. Off, these changes are read past and nothing changes.

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

With none of those four switches on, the calls above the "Linking an Organization"
row are all there is. Creating or deploying an App for a person
(`EVER_CONNECT_APPS_WRITE_ENABLED`) makes no call to Ever Platform: it answers a
request, and what it creates is told only by the apps mirror.

## Creating a company from Ever Platform

Off by default (`EVER_CONNECT_PROVISIONING_ENABLED`, and `EVER_CONNECT_PROVISION_STAFFING_ENABLED` for starter staff and the first Mission). A person who starts a company on app.ever.co and chooses Ever Works arrives at `/ever-connect/provision` with a signed request in the URL fragment, signs in with Ever ID and confirms once. Works then creates the Company Work, the Organization (slug = the Ever handle, or `handle-2` when it is taken) and its link, and tells Ever Platform (`POST /v1/provision-intents/{jti}/complete`: the tenant, the Organization's slug, the owner's account id and the company's address; no name, no e-mail), retrying within a day.

The same request again answers the same company. A stopped creation is finished by its retry, also under a new request for the same step. A failed staffing or Mission step leaves the company in place (`partial`). Requests are kept until a day after they end, records 30 days.
