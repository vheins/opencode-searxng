import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESULTS,
  SearxngError,
  buildSearchUrl,
  formatResults,
  normalizeBaseUrl,
  parseSearchPayload,
  resolveConfig,
  searchSearxng,
  type FetchLike,
} from "./searxng.ts"

type Captured = { url: string; init?: RequestInit }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function textResponse(body: string, status = 200, contentType = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } })
}

function capture(): { calls: Captured[]; fetchImpl: FetchLike } {
  const calls: Captured[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) })
    return jsonResponse({ results: [] })
  }
  return { calls, fetchImpl }
}

test("resolveConfig applies defaults from an empty environment", () => {
  const config = resolveConfig({}, {})
  assert.equal(config.baseUrl, DEFAULT_BASE_URL)
  assert.equal(config.maxResults, DEFAULT_MAX_RESULTS)
  assert.equal(config.token, undefined)
})

test("resolveConfig prefers explicit options over environment", () => {
  const config = resolveConfig(
    { baseUrl: "https://search.internal/", token: "opt-token", maxResults: 3, language: "de-DE" },
    { SEARXNG_URL: "http://env:8080", SEARXNG_TOKEN: "env-token" },
  )
  assert.equal(config.baseUrl, "https://search.internal")
  assert.equal(config.token, "opt-token")
  assert.equal(config.maxResults, 3)
  assert.equal(config.language, "de-DE")
})

test("resolveConfig falls back to environment then defaults", () => {
  const config = resolveConfig({}, { SEARXNG_URL: "http://env:8080/", SEARXNG_TOKEN: "env-token" })
  assert.equal(config.baseUrl, "http://env:8080")
  assert.equal(config.token, "env-token")
  assert.equal(config.maxResults, DEFAULT_MAX_RESULTS)
})

test("resolveConfig joins category arrays and rejects invalid enums", () => {
  const config = resolveConfig({ categories: ["general", "news"], timeRange: "day", safesearch: 1 }, {})
  assert.equal(config.categories, "general,news")
  assert.equal(config.timeRange, "day")
  assert.equal(config.safesearch, 1)

  const invalid = resolveConfig({ timeRange: "century" as never, safesearch: 9 as never }, {})
  assert.equal(invalid.timeRange, undefined)
  assert.equal(invalid.safesearch, undefined)
})

test("normalizeBaseUrl strips trailing slashes and falls back to the default", () => {
  assert.equal(normalizeBaseUrl("http://localhost:8080///"), "http://localhost:8080")
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL)
})

test("buildSearchUrl always sets format=json and encodes the query", () => {
  const url = buildSearchUrl({
    baseUrl: "http://localhost:8080/",
    query: "hello world & goodbye",
    categories: "general",
    timeRange: "month",
    pageno: 2,
    safesearch: 0,
  })
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, "http://localhost:8080/search")
  assert.equal(parsed.searchParams.get("q"), "hello world & goodbye")
  assert.equal(parsed.searchParams.get("format"), "json")
  assert.equal(parsed.searchParams.get("categories"), "general")
  assert.equal(parsed.searchParams.get("time_range"), "month")
  assert.equal(parsed.searchParams.get("pageno"), "2")
  assert.equal(parsed.searchParams.get("safesearch"), "0")
})

test("happy path parses results and applies maxResults", async () => {
  const payload = {
    results: [
      { url: "https://a.example", title: "A", content: "first", engine: "google", score: 1.5 },
      { url: "https://b.example", title: "B", content: "second", engine: "bing", score: 0.9 },
      { url: "https://c.example", title: "C", content: "third" },
    ],
  }
  let seenUrl = ""
  const results = await searchSearxng({
    baseUrl: "http://localhost:8080",
    query: "opencode",
    maxResults: 2,
    fetchImpl: async (input) => {
      seenUrl = String(input)
      return jsonResponse(payload)
    },
  })

  assert.equal(results.length, 2)
  assert.deepEqual(results[0], {
    url: "https://a.example",
    title: "A",
    content: "first",
    engine: "google",
    score: 1.5,
  })
  assert.equal(results[1]?.url, "https://b.example")
  const parsed = new URL(seenUrl)
  assert.equal(parsed.searchParams.get("format"), "json")
  assert.equal(parsed.searchParams.get("q"), "opencode")
})

test("token adds the Authorization bearer header", async () => {
  const { calls, fetchImpl } = capture()
  await searchSearxng({ baseUrl: "http://localhost:8080", query: "q", token: "secret", fetchImpl })

  assert.equal(calls.length, 1)
  const headers = calls[0]?.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer secret")
  assert.equal(headers.Accept, "application/json")
})

test("no token means no Authorization header", async () => {
  const { calls, fetchImpl } = capture()
  await searchSearxng({ baseUrl: "http://localhost:8080", query: "q", fetchImpl })
  const headers = calls[0]?.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, undefined)
})

test("HTTP 403 produces an actionable JSON-format error", async () => {
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "q",
        fetchImpl: async () => textResponse("<html><body>Forbidden</body></html>", 403),
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearxngError)
      assert.equal(error.code, "HTTP_ERROR")
      assert.equal(error.status, 403)
      assert.match(error.message, /403/)
      assert.match(error.message, /search\.formats/)
      assert.match(error.message, /json/)
      return true
    },
  )
})

test("other non-200 responses produce an HTTP error", async () => {
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "q",
        fetchImpl: async () => textResponse("nope", 502, "text/plain"),
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearxngError)
      assert.equal(error.code, "HTTP_ERROR")
      assert.equal(error.status, 502)
      return true
    },
  )
})

test("an HTML body (captcha page) produces a clear NON_JSON error", async () => {
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "q",
        fetchImpl: async () => textResponse("<!doctype html><html><body>captcha</body></html>", 200),
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearxngError)
      assert.equal(error.code, "NON_JSON")
      assert.match(error.message, /captcha|format=json/)
      return true
    },
  )
})

test("a non-JSON 200 body produces a clear NON_JSON error", async () => {
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "q",
        fetchImpl: async () => textResponse("not json at all", 200, "text/plain"),
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearxngError)
      assert.equal(error.code, "NON_JSON")
      assert.match(error.message, /valid JSON/)
      return true
    },
  )
})

test("network failure is wrapped in a NETWORK SearxngError", async () => {
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "q",
        fetchImpl: async () => {
          throw new TypeError("fetch failed")
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearxngError)
      assert.equal(error.code, "NETWORK")
      assert.match(error.message, /SEARXNG_URL/)
      return true
    },
  )
})

test("AbortError is rethrown untouched", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "q",
        fetchImpl: async () => {
          throw abort
        },
      }),
    (error: unknown) => {
      assert.ok(!(error instanceof SearxngError))
      assert.equal((error as { name: string }).name, "AbortError")
      return true
    },
  )
})

test("an empty query is rejected without a network call", async () => {
  let called = false
  await assert.rejects(
    () =>
      searchSearxng({
        baseUrl: "http://localhost:8080",
        query: "   ",
        fetchImpl: async () => {
          called = true
          return jsonResponse({ results: [] })
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearxngError)
      assert.equal(error.code, "INVALID_RESPONSE")
      return true
    },
  )
  assert.equal(called, false)
})

test("parseSearchPayload drops entries without a URL and tolerates a missing results array", () => {
  const parsed = parseSearchPayload({
    results: [
      { url: "https://ok.example", title: "ok", content: "c" },
      { title: "no url" },
      "garbage",
    ],
  })
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.url, "https://ok.example")

  assert.deepEqual(parseSearchPayload({}), [])
})

test("parseSearchPayload rejects non-object payloads", () => {
  assert.throws(
    () => parseSearchPayload("nope"),
    (error: unknown) => error instanceof SearxngError && error.code === "INVALID_RESPONSE",
  )
  assert.throws(
    () => parseSearchPayload({ results: "nope" }),
    (error: unknown) => error instanceof SearxngError && error.code === "INVALID_RESPONSE",
  )
})

test("formatResults renders titles, URLs and snippets", () => {
  const text = formatResults([
    { url: "https://a.example", title: "A", content: "first" },
    { url: "https://b.example", title: "", content: "" },
  ])
  assert.match(text, /1\. A\nhttps:\/\/a\.example\nfirst/)
  assert.match(text, /2\. https:\/\/b\.example/)
  assert.equal(formatResults([]), "No results found.")
})
