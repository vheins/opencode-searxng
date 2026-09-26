/**
 * Dual-mode OpenCode plugin entrypoint.
 *
 * - **V2** (`@opencode/plugin`): reads the default export's `id` + `setup()`.
 *   Registers a SearXNG-backed websearch provider via `ctx.websearch.transform`
 *   and a lightweight `web_fetch` tool via `ctx.tool.transform`.
 * - **V1** (`@opencode-ai/plugin`): calls `server()` and uses the returned
 *   `Hooks.tool` map (`web_search`, `web_fetch`).
 *
 * Both halves share {@link searchSearxng} but are otherwise independent: the
 * V2 transform editor and the V1 hooks object are different APIs and are never
 * translated into one another.
 *
 * @see https://opencode.ai/v2/docs/build/plugins
 */

import { Plugin, WebSearch } from "@opencode/plugin"
import { tool, type Hooks } from "@opencode-ai/plugin"
import { z } from "zod"

import {
  DEFAULT_MAX_RESULTS,
  formatResults,
  resolveConfig,
  searchSearxng,
  type SearxngConfig,
  type SearxngPluginOptions,
  type SearxngResult,
} from "./searxng.ts"

/** V2 websearch provider id / V1 tool family name. */
const PROVIDER_ID = "searxng"

/** Options may arrive as `unknown` from the host; keep only the fields we own. */
function toOptions(input: unknown): SearxngPluginOptions {
  if (typeof input !== "object" || input === null) return {}
  const record = input as Record<string, unknown>
  const options: SearxngPluginOptions = {}
  if (typeof record.baseUrl === "string") options.baseUrl = record.baseUrl
  if (typeof record.url === "string") options.url = record.url
  if (typeof record.token === "string") options.token = record.token
  if (typeof record.maxResults === "number") options.maxResults = record.maxResults
  if (typeof record.categories === "string" || Array.isArray(record.categories)) {
    options.categories = record.categories as string | readonly string[]
  }
  if (typeof record.language === "string") options.language = record.language
  if (record.timeRange === "day" || record.timeRange === "month" || record.timeRange === "year") {
    options.timeRange = record.timeRange
  }
  if (record.safesearch === 0 || record.safesearch === 1 || record.safesearch === 2) {
    options.safesearch = record.safesearch
  }
  return options
}

/** Run a query through the shared client using a resolved config. */
async function runSearch(config: SearxngConfig, query: string, signal?: AbortSignal): Promise<SearxngResult[]> {
  return searchSearxng({
    baseUrl: config.baseUrl,
    query,
    ...(config.token !== undefined ? { token: config.token } : {}),
    ...(config.categories !== undefined ? { categories: config.categories } : {}),
    ...(config.language !== undefined ? { language: config.language } : {}),
    ...(config.timeRange !== undefined ? { timeRange: config.timeRange } : {}),
    ...(config.safesearch !== undefined ? { safesearch: config.safesearch } : {}),
    maxResults: config.maxResults,
    ...(signal !== undefined ? { signal } : {}),
  })
}

/** Map a normalized result to the documented `WebSearch.Result` shape. */
function toWebSearchResult(result: SearxngResult): WebSearch.Result {
  return {
    url: result.url,
    title: result.title,
    content: result.content,
    time: {},
  }
}

/** Fetch a URL as text, guarding against obvious non-HTTP schemes. */
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`web_fetch only supports http(s) URLs, received: ${url}`)
  }
  const response = await fetch(url, signal === undefined ? {} : { signal })
  if (!response.ok) {
    throw new Error(`web_fetch failed: HTTP ${response.status} ${response.statusText}`.trim())
  }
  return response.text()
}

const WEB_FETCH_DESCRIPTION = "Fetch a URL over HTTP(S) and return its raw response body as text."

/**
 * V2 JSON Schema for the `web_fetch` tool input.
 * Typed as the open `JsonSchema.JsonSchema` record so it satisfies `Tool.ValueSchema`.
 */
const WEB_FETCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Absolute http(s) URL to fetch.",
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const

/** V2 definition: register the provider + tool on their respective domains. */
const v2 = Plugin.define({
  id: PROVIDER_ID,
  async setup(ctx) {
    const config = resolveConfig(toOptions(ctx.options))

    await ctx.websearch.transform((editor) => {
      editor.add({
        id: PROVIDER_ID,
        name: "SearXNG",
        execute: async ({ query }, { signal }) => {
          const results = await runSearch(config, query, signal)
          return results.map(toWebSearchResult)
        },
      })
      editor.default.set(PROVIDER_ID)
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "web_fetch",
        description: WEB_FETCH_DESCRIPTION,
        input: WEB_FETCH_INPUT_SCHEMA,
        execute: async (input, context) => {
          const url = (input as { url?: unknown }).url
          if (typeof url !== "string" || url === "") {
            throw new Error("web_fetch requires a `url` string.")
          }
          return { content: await fetchText(url, context.signal) }
        },
      })
    })
  },
})

/** V1 definition: register the equivalent tools through `Hooks.tool`. */
async function server(_input: unknown, options?: unknown): Promise<Hooks> {
  const config = resolveConfig(toOptions(options))

  return {
    tool: {
      // NOTE: deliberately NOT named `websearch` — V1 filters a custom tool with
      // that exact name behind Exa/Parallel gating, making it invisible.
      web_search: tool({
        description:
          `Search the web through the configured SearXNG instance (${config.baseUrl}). ` +
          `Returns up to ${config.maxResults} results with title, URL and snippet.`,
        args: {
          query: z.string().describe("The search query."),
        },
        async execute(args, context) {
          const results = await runSearch(config, args.query, context.abort)
          return {
            title: `SearXNG: ${args.query}`,
            output: formatResults(results),
            metadata: { provider: PROVIDER_ID, results: results.length, baseUrl: config.baseUrl },
          }
        },
      }),
      web_fetch: tool({
        description: WEB_FETCH_DESCRIPTION,
        args: {
          url: z.string().describe("Absolute http(s) URL to fetch."),
        },
        async execute(args, context) {
          return {
            title: `web_fetch: ${args.url}`,
            output: await fetchText(args.url, context.abort),
          }
        },
      }),
    },
  }
}

export default {
  ...v2,
  server,
}

/** Re-export the shared client so consumers can unit-test / reuse it. */
export { DEFAULT_MAX_RESULTS, resolveConfig, searchSearxng }
export type { SearxngConfig, SearxngPluginOptions, SearxngResult }
