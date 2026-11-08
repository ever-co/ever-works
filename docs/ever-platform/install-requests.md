---
id: install-requests
title: Install requests from apps.ever.co
sidebar_label: Install requests from apps.ever.co
description: How an organization owner asks, on apps.ever.co, for a plugin to be installed into a connected Ever Works installation, and how a platform admin approves or declines it. Nothing is installed without that approval.
---

# Install requests from apps.ever.co

An organization owner can pick a plugin on apps.ever.co and ask for it to be installed into one of
their connected Ever Works installations. The installation receives the request, shows it to its
platform admins, and **installs nothing until a platform admin approves it** in Ever Works.

## What has to be on

Everything here is off by default. A request reaches an installation only when all of these hold:

- the Ever Platform connection is on and connected (`EVER_CONNECT_ENABLED=true`, see
  [Connecting Ever Works to Ever Platform](./connection.md));
- the organization turned on **Install apps from apps.ever.co** (the `marketplace_installs`
  integration) for this installation on Ever Platform. Until then the installation receives no
  request, keeps nothing and sends nothing about installs.

Approving a request also needs dynamic plugin installs: `PLUGIN_DISTRIBUTION_MODE=dynamic` (see
[Plugin system](../plugin-system/index.md) and [Environment variables](../environment-variables.md)).
With any other mode the request can be seen and declined, but not approved.

No new environment variable is needed.

## What a request contains

A request names the listing on apps.ever.co (its slug), the npm package, the version (an exact
version or a semver range), the integrity of the package when the listing declares it, and the
edition chosen. It never names a tenant, a person, an organization name or a configuration value.
A request with any other field is refused and nothing of it is kept.

## Where to find it

Platform admins get an in-app notification, "Install requested from apps.ever.co", and see every
request under **Settings → Ever Platform → Install requests**: the listing, `package@version`, the
integrity (copyable), the edition, when it arrived and its state.

The section is shown to platform admins only. With the Ever Platform connection off, the routes
answer `404` and the section does not exist.

## Approving

**Approve and install** runs Works' own dynamic plugin installer, exactly as
`POST /api/plugins/:pluginId/install` does:

1. The package must be on the plugin allow-list (first-party `@ever-works/*` packages always are).
   When it is not, the request shows an unticked box, **Add {package} to the plugin allow-list**.
   Ever Platform never changes this list; only you do. Approving without ticking it is refused and
   the request stays open; ticking it adds the package, pinned to the requested version and
   integrity, and your Activity records it. A package that is on the list but turned off there stays
   off: turn it on in the allow-list first.
2. The installer fetches the requested version and checks it against the declared integrity before
   anything is placed. A package whose integrity differs is not installed.
3. The plugin is registered and appears in the plugin list like one installed by hand.

Only the package, version and integrity the request declared are installed. Approving needs a
platform admin's own signed-in session; an API key acting as the admin is refused.

A request whose package is not npm, or that no plugin of this installation is published as, cannot
be approved here; the row says so.

## Declining, withdrawals and removals

- **Decline** closes the request. apps.ever.co is told it was not installed.
- When the organization owner cancels a request before it was answered, it is shown as
  **Withdrawn** and its notification is taken back.
- When the organization owner asks to remove a plugin installed from a request, the platform admins
  get a notice. Nothing is uninstalled: a platform admin uninstalls it in Plugins as usual.

## What apps.ever.co is told

The installation reports each step to Ever Platform (`POST /v1/installs/{install}/status`), under
the same integration and tenant link the request came with. A report carries the install id, a
state and, for a failure, a fixed token; for an installed plugin, the plugin's id. Never a package
URL, a token or an error text: free text stays in the installation's logs.

| State on apps.ever.co | When                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| Installing            | A platform admin approved it and the installer runs.                              |
| Installed             | The plugin was installed and registered.                                          |
| Failed                | Declined, or the install did not complete; the reason is one of the tokens below. |
| Removed               | The plugin installed from the request was uninstalled in Ever Works.              |

| Failure token          | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `checksum_mismatch`    | The package did not match the declared integrity.                  |
| `incompatible_version` | The package is not a plugin this installation can run.             |
| `installer_disabled`   | Dynamic plugin installs are off here (`PLUGIN_DISTRIBUTION_MODE`). |
| `permission_denied`    | Declined by a platform admin, or refused by the plugin allow-list. |
| `unknown`              | Anything else; the reason is in the API's logs.                    |

A report that cannot be sent right away is retried by the connection's background worker. When the
integration is turned off, reports still owed are dropped and never sent later.

## Routes

Platform admins only; the module answers `404` unless `EVER_CONNECT_ENABLED=true`.

| Route                                                                           | What it does                              |
| ------------------------------------------------------------------------------- | ----------------------------------------- |
| `GET /api/ever-connect/install-requests`                                        | The open requests and the recent answers. |
| `POST /api/ever-connect/install-requests/:installId/approve` `{addToAllowlist}` | Approve: install the declared package.    |
| `POST /api/ever-connect/install-requests/:installId/decline`                    | Decline.                                  |

Approve answers `409 not_open` for a request already answered or withdrawn, `409
integration_not_enabled` once the integration is off, and `422` with `installer_disabled`,
`not_installable`, `package_not_allowlisted` or `package_allowlist_disabled`.
