# @ever-works/gotenberg-plugin

Gotenberg screenshot plugin for Ever Works — capture website screenshots with a self-hosted, open-source [Gotenberg](https://gotenberg.dev) server. **The default screenshot provider.**

## Plugin metadata

| Field                    | Value           |
| ------------------------ | --------------- |
| ID                       | `gotenberg`     |
| Category                 | `screenshot`    |
| Capabilities             | `screenshot`    |
| Default for capabilities | `screenshot`    |
| Author                   | Ever Works Team |
| License                  | AGPL-3.0        |
| Built-in / System        | yes / yes       |
| Auto-enable              | yes             |

## Why it is the default

- **Self-hosted** — Gotenberg (MIT, Chromium) runs next to the API; no third-party account
- **No per-screenshot cost** — ScreenshotOne and Urlbox stay available as paid, opt-in alternatives
- **Safe by default** — the plugin refuses non-HTTP(S) and literal private targets, and the server's
  `--chromium-deny-private-ips` refuses hostnames that resolve to private addresses

## Configuration

| Variable                    | Required | Description                                                             |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `PLUGIN_GOTENBERG_BASE_URL` | No\*     | Gotenberg URL, e.g. `http://gotenberg:3000` (\*unavailable without it)  |
| `PLUGIN_GOTENBERG_USERNAME` | No       | Basic-auth username (default `gotenberg`)                               |
| `PLUGIN_GOTENBERG_TOKEN`    | No       | Basic-auth password for a server started with `--api-enable-basic-auth` |

The base URL is operator configuration: as an `x-envVar` field without `x-secret` it is never accepted
from a user or Work settings write. No setting is `required`, so an instance without Gotenberg never has
generation refused because the default screenshot provider "is not configured" — items just get no image.

Gotenberg returns image bytes, not a URL. The screenshot facade gives such captures a signed, cacheable
URL on the platform's own API when `SCREENSHOT_IMAGE_BASE_URL` is set (see
[`docs/plugin-system/gotenberg-plugin.md`](../../../docs/plugin-system/gotenberg-plugin.md)).

## Running Gotenberg locally

```bash
docker run --rm -p 3000:3000 gotenberg/gotenberg:9-chromium gotenberg --chromium-deny-private-ips
export PLUGIN_GOTENBERG_BASE_URL=http://localhost:3000
```

## Development

```bash
pnpm --filter @ever-works/gotenberg-plugin build
pnpm --filter @ever-works/gotenberg-plugin test
```
