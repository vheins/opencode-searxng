/**
 * Unit tests for the dual-mode plugin entrypoint (`src/index.ts`).
 *
 * Everything runs against a mocked `globalThis.fetch` — no network access.
 * V2 is exercised through a lightweight fake `Context` exposing just the
 * `websearch.transform` / `tool.transform` domains and `options`; V1 through the
 * `Hooks.tool` map returned by `server()`.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import plugin, {
  PROVIDER_ID,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_INPUT_SCHEMA,
  fetchText,
  server,
  v2,
} from "./index.ts"

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Minimal structural shape of a captured V2 websearch provider definition. */
type CapturedProvider = {
  id: string
  name: string
  execute: (input: { query: string }, context: { signal: AbortSignal }) => Promise<readonly unknown[]>
}

/** Minimal structural shape of a captured V2 tool definition. */
type CapturedTool = {
  name: string
  description: string
  input: unknown
  execute: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Run `fn` with `globalThis.fetch` temporarily replaced, always restoring it. */
async function withFetch<T>(impl: FetchLike, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** Build a fake V2 `Context` capturing provider/tool registrations. */
function fakeV2Context(options: Record<string, unknown>) {
  const providers: CapturedProvider[] = []
  const tools: CapturedTool[] = []
  let defaultProvider: string | false | undefined

  const ctx = {
    options,
    websearch: {
      transform: async (
        callback: (editor: {
          add: (definition: CapturedProvider) => void
          default: { set: (selection: string | false) => void }
        }) => void,
      ) => {
        callback({
          add: (definition) => {
            providers.push(definition)
          },
          default: {
            set: (selection) => {
              defaultProvider = selection
            },
          },
        })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (definition: CapturedTool) => void }) => void) => {
        callback({
          add: (definition) => {
            tools.push(definition)
          },
        })
        return { dispose: async () => {} }
      },
    },
  }

  return {
    ctx: ctx as unknown as Parameters<typeof v2.setup>[0],
    providers,
    tools,
    defaultProvider: () => defaultProvider,
  }
}

/** V1 tools only read `context.abort`; a minimal fake suffices. */
function toolContext(): { abort: AbortSignal } {
  return { abort: new AbortController().signal }
}

test("default export is a dual-mode plugin exposing id, setup and server", () => {
  assert.equal(plugin.id, PROVIDER_ID)
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

test("V2 setup registers the searxng provider and sets it as default", async () => {
  const { ctx, providers, defaultProvider } = fakeV2Context({ baseUrl: "http://localhost:8080" })
  await v2.setup(ctx)

  assert.equal(providers.length, 1)
  assert.equal(providers[0]?.id, PROVIDER_ID)
  assert.equal(providers[0]?.name, "SearXNG")
  assert.equal(defaultProvider(), PROVIDER_ID)
})

test("V2 setup registers the web_fetch tool with schema and description", async () => {
  const { ctx, tools } = fakeV2Context({ baseUrl: "http://localhost:8080" })
  await v2.setup(ctx)

  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, "web_fetch")
  assert.equal(tools[0]?.description, WEB_FETCH_DESCRIPTION)
  assert.deepEqual(tools[0]?.input, WEB_FETCH_INPUT_SCHEMA)
})

test("V2 websearch execute returns WebSearch.Result[] shaped {url,title,content,time}", async () => {
  const { ctx, providers } = fakeV2Context({ baseUrl: "http://localhost:8080" })
  await v2.setup(ctx)
  const provider = providers[0]
  assert.ok(provider)

  const results = await withFetch(
    async () =>
      jsonResponse({
        results: [{ url: "https://a.example", title: "A", content: "snippet", engine: "google" }],
      }),
    () => provider.execute({ query: "opencode" }, { signal: new AbortController().signal }),
  )

  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    url: "https://a.example",
    title: "A",
    content: "snippet",
    time: {},
  })
})

test("V2 web_fetch tool returns { content } from a mocked fetch", async () => {
  const { ctx, tools } = fakeV2Context({ baseUrl: "http://localhost:8080" })
  await v2.setup(ctx)
  const fetchTool = tools[0]
  assert.ok(fetchTool)

  const result = await withFetch(
    async () => new Response("hello body", { status: 200 }),
    () => fetchTool.execute({ url: "https://a.example" }, { signal: new AbortController().signal }),
  )

  assert.deepEqual(result, { content: "hello body" })
})

test("V2 web_fetch tool rejects a missing url", async () => {
  const { ctx, tools } = fakeV2Context({ baseUrl: "http://localhost:8080" })
  await v2.setup(ctx)
  const fetchTool = tools[0]
  assert.ok(fetchTool)

  await assert.rejects(
    () => fetchTool.execute({}, { signal: new AbortController().signal }),
    /requires a `url` string/,
  )
})

test("V1 server() registers web_search and web_fetch hooks", async () => {
  const hooks = await server({}, { baseUrl: "http://localhost:8080" })
  const tools = hooks.tool
  assert.ok(tools)

  const search = tools.web_search
  const fetch = tools.web_fetch
  assert.ok(search)
  assert.ok(fetch)

  assert.match(search.description, /SearXNG/)
  assert.match(search.description, /http:\/\/localhost:8080/)
  assert.ok(search.args.query)
  assert.equal(fetch.description, WEB_FETCH_DESCRIPTION)
  assert.ok(fetch.args.url)
})

test("V1 web_search.execute returns formatted output and metadata", async () => {
  const hooks = await server({}, { baseUrl: "http://localhost:8080" })
  const search = hooks.tool?.web_search
  assert.ok(search)

  const result = await withFetch(
    async () =>
      jsonResponse({
        results: [
          { url: "https://a.example", title: "A", content: "first" },
          { url: "https://b.example", title: "B", content: "second" },
        ],
      }),
    () => search.execute({ query: "opencode" }, toolContext() as never),
  )

  assert.equal(typeof result, "object")
  const shaped = result as { title: string; output: string; metadata: Record<string, unknown> }
  assert.equal(shaped.title, "SearXNG: opencode")
  assert.match(shaped.output, /https:\/\/a\.example/)
  assert.match(shaped.output, /https:\/\/b\.example/)
  assert.equal(shaped.metadata.provider, PROVIDER_ID)
  assert.equal(shaped.metadata.results, 2)
  assert.equal(shaped.metadata.baseUrl, "http://localhost:8080")
})

test("V1 web_fetch.execute returns the fetched body as text", async () => {
  const hooks = await server({}, { baseUrl: "http://localhost:8080" })
  const fetch = hooks.tool?.web_fetch
  assert.ok(fetch)

  const result = await withFetch(
    async () => new Response("body text", { status: 200 }),
    () => fetch.execute({ url: "https://a.example" }, toolContext() as never),
  )

  const shaped = result as { title: string; output: string }
  assert.equal(shaped.title, "web_fetch: https://a.example")
  assert.equal(shaped.output, "body text")
})

test("fetchText guards non-http(s) schemes", async () => {
  await assert.rejects(() => fetchText("file:///etc/passwd"), /http\(s\)/)
  await assert.rejects(() => fetchText("ftp://example.com/resource"), /http\(s\)/)
})

test("fetchText surfaces non-2xx responses as an error", async () => {
  await assert.rejects(
    () => withFetch(async () => new Response("nope", { status: 500 }), () => fetchText("https://a.example")),
    /HTTP 500/,
  )
})
