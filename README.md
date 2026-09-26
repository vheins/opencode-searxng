# opencode-searxng

A dual-mode [OpenCode](https://opencode.ai) plugin that backs **websearch** and a
lightweight **webfetch** tool with your own [SearXNG](https://docs.searxng.org/)
instance.

One package, two runtimes:

| Runtime | SDK | How it registers |
| --- | --- | --- |
| **V2** | `@opencode/plugin` | `setup(ctx)` → `ctx.websearch.transform` (provider) + `ctx.tool.transform` (`web_fetch`) |
| **V1** | `@opencode-ai/plugin` | `server()` → `Hooks.tool` (`web_search`, `web_fetch`) |

The V2 half registers SearXNG as a first-class **websearch provider** and selects
it as the default. The V1 half registers equivalent **tools** instead.

## Install

```sh
bun add opencode-searxng
# or: npm install opencode-searxng
```

## Configuration

### V2 (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-searxng",
      "options": {
        "baseUrl": "http://localhost:8080",
        "maxResults": 8,
        "categories": "general",
        "language": "en"
      }
    }
  ]
}
```

### V1 (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-searxng"]
}
```

The V1 loader also accepts the `[package, options]` tuple form:

```jsonc
{
  "plugin": [
    ["opencode-searxng", { "baseUrl": "http://localhost:8080", "maxResults": 5 }]
  ]
}
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `string` | `http://localhost:8080` | SearXNG base URL. Alias: `url`. |
| `token` | `string` | — | Sent as `Authorization: Bearer <token>`. |
| `maxResults` | `number` | `8` | Client-side result slice. |
| `categories` | `string \| string[]` | — | SearXNG categories, e.g. `"general,news"`. |
| `language` | `string` | — | Language code, e.g. `"en"`, `"de-DE"`. |
| `timeRange` | `"day" \| "month" \| "year"` | — | Restrict results by recency. |
| `safesearch` | `0 \| 1 \| 2` | — | Safe search level. |

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SEARXNG_URL` | `http://localhost:8080` | Base URL. Overridden by the `baseUrl`/`url` option. |
| `SEARXNG_TOKEN` | — | Bearer token. Overridden by the `token` option. |

Precedence: **explicit option → environment variable → built-in default**.

## ⚠️ `format=json` must be enabled on your instance

SearXNG disables the JSON API by default. If `json` is not listed in
`search.formats`, the server answers **HTTP 403** for `format=json` requests.

Edit `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Then restart SearXNG. The plugin detects the 403 and raises an error that names
`search.formats` explicitly so the fix is obvious.

## ⚠️ V1 tool-name shadowing

On V1 the plugin registers `web_search` (not `websearch`). A V1 plugin tool whose
name is **exactly** `websearch` is filtered by OpenCode's Exa/Parallel gating and
becomes invisible to the model. If you copy this plugin, keep a distinct name.

On V2 the provider is registered through the websearch **provider** registry
(id `searxng`) and selected as the default — no name shadowing involved.

## API (for reuse / testing)

`src/searxng.ts` exports the shared client:

```ts
import { searchSearxng, resolveConfig } from "opencode-searxng"

const config = resolveConfig({ baseUrl: "http://localhost:8080" })
const results = await searchSearxng({ baseUrl: config.baseUrl, query: "opencode plugins" })
// → [{ url, title, content, engine?, score? }]
```

Failures are always a `SearxngError` with a machine-readable `code`
(`HTTP_ERROR` | `NON_JSON` | `NETWORK` | `INVALID_RESPONSE`) and, for HTTP
failures, a `status`. Cancellation via an `AbortSignal` is rethrown as
`AbortError` so callers can distinguish it from a real failure.

## Development

```sh
bun install
bunx tsc --noEmit          # type-check (both V1 + V2 SDKs)
bun test src/searxng.test.ts
# or, zero extra deps:
node --test --experimental-strip-types src/searxng.test.ts
```

## License

MIT
