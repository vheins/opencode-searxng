/**
 * Shared SearXNG HTTP client used by both the V1 and V2 plugin entrypoints.
 *
 * The SearXNG search API is a simple GET request:
 *   GET {baseUrl}/search?q=<query>&format=json
 * with optional `categories`, `language`, `time_range`, `pageno`, `safesearch`.
 *
 * CAVEAT: `format=json` must be enabled on the instance (`search.formats` in
 * `settings.yml`) or SearXNG answers HTTP 403. There is no `numResults`
 * parameter, so results are sliced client-side.
 *
 * @see https://docs.searxng.org/dev/search_api.html
 */

/** Default SearXNG instance URL used when neither options nor env provide one. */
export const DEFAULT_BASE_URL = "http://localhost:8080"

/** Default number of results returned per query. */
export const DEFAULT_MAX_RESULTS = 8

/** SearXNG `time_range` values. */
export type TimeRange = "day" | "month" | "year"

/** SearXNG `safesearch` values (0 = off, 1 = moderate, 2 = strict). */
export type SafeSearch = 0 | 1 | 2

/** A single normalized search result. */
export type SearxngResult = {
  url: string
  title: string
  content: string
  engine?: string
  score?: number
}

/** Machine-readable error categories emitted by this module. */
export type SearxngErrorCode = "HTTP_ERROR" | "NON_JSON" | "NETWORK" | "INVALID_RESPONSE"

/**
 * Error thrown for every failure mode of {@link searchSearxng}.
 *
 * `code` classifies the failure and `status` carries the HTTP status when the
 * failure came from an actual response.
 */
export class SearxngError extends Error {
  readonly code: SearxngErrorCode
  readonly status?: number

  constructor(message: string, options: { code: SearxngErrorCode; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "SearxngError"
    this.code = options.code
    if (options.status !== undefined) this.status = options.status
  }
}

/** Minimal fetch signature so tests can inject a stub without patching globals. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Plugin options as authored in `opencode.json(c)`. All fields are optional. */
export type SearxngPluginOptions = {
  /** SearXNG base URL, e.g. `http://localhost:8080`. */
  baseUrl?: string
  /** Alias for {@link SearxngPluginOptions.baseUrl}. */
  url?: string
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string
  /** Maximum number of results returned (client-side slice). Defaults to 8. */
  maxResults?: number
  /** Comma-separated categories or an array of them. */
  categories?: string | readonly string[]
  /** Language code, e.g. `en`, `de-DE`. */
  language?: string
  /** Restrict results by recency. */
  timeRange?: TimeRange
  /** Safe search level. */
  safesearch?: SafeSearch
}

/** Fully resolved configuration (defaults + env applied). */
export type SearxngConfig = {
  baseUrl: string
  token?: string
  maxResults: number
  categories?: string
  language?: string
  timeRange?: TimeRange
  safesearch?: SafeSearch
}

/** Arguments accepted by {@link searchSearxng}. */
export type SearxngSearchOptions = {
  baseUrl: string
  query: string
  token?: string
  maxResults?: number
  categories?: string
  language?: string
  timeRange?: TimeRange
  pageno?: number
  safesearch?: SafeSearch
  signal?: AbortSignal
  /** Override the fetch implementation (used by tests). */
  fetchImpl?: FetchLike
}

const TIME_RANGES: readonly TimeRange[] = ["day", "month", "year"]

function isTimeRange(value: unknown): value is TimeRange {
  return typeof value === "string" && (TIME_RANGES as readonly string[]).includes(value)
}

function isSafeSearch(value: unknown): value is SafeSearch {
  return value === 0 || value === 1 || value === 2
}

/** Strip trailing slashes so `${base}/search` never double-slashes. */
export function normalizeBaseUrl(input: string | undefined): string {
  const trimmed = (input ?? "").trim()
  if (trimmed === "") return DEFAULT_BASE_URL
  return trimmed.replace(/\/+$/, "")
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function normalizeCategories(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  const parts = (Array.isArray(value) ? value : String(value).split(","))
    .map((part) => String(part).trim())
    .filter((part) => part !== "")
  return parts.length > 0 ? parts.join(",") : undefined
}

/**
 * Merge plugin options with environment variables.
 *
 * Precedence: explicit option > environment variable > built-in default.
 * Environment: `SEARXNG_URL` (default `http://localhost:8080`) and
 * `SEARXNG_TOKEN`.
 */
export function resolveConfig(
  options: SearxngPluginOptions = {},
  env: Record<string, string | undefined> = process.env,
): SearxngConfig {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? options.url ?? env.SEARXNG_URL)
  const token = asNonEmptyString(options.token) ?? asNonEmptyString(env.SEARXNG_TOKEN)
  const maxResults = asPositiveInt(options.maxResults) ?? DEFAULT_MAX_RESULTS
  const categories = normalizeCategories(options.categories)
  const language = asNonEmptyString(options.language)
  const timeRange = isTimeRange(options.timeRange) ? options.timeRange : undefined
  const safesearch = isSafeSearch(options.safesearch) ? options.safesearch : undefined

  const config: SearxngConfig = { baseUrl, maxResults }
  if (token !== undefined) config.token = token
  if (categories !== undefined) config.categories = categories
  if (language !== undefined) config.language = language
  if (timeRange !== undefined) config.timeRange = timeRange
  if (safesearch !== undefined) config.safesearch = safesearch
  return config
}

/** Build the fully-qualified search URL. Always sets `format=json`. */
export function buildSearchUrl(input: {
  baseUrl: string
  query: string
  categories?: string
  language?: string
  timeRange?: TimeRange
  pageno?: number
  safesearch?: SafeSearch
}): string {
  const base = normalizeBaseUrl(input.baseUrl)
  const params = new URLSearchParams()
  params.set("q", input.query)
  params.set("format", "json")
  if (input.categories !== undefined && input.categories !== "") params.set("categories", input.categories)
  if (input.language !== undefined && input.language !== "") params.set("language", input.language)
  if (input.timeRange !== undefined) params.set("time_range", input.timeRange)
  if (input.pageno !== undefined) params.set("pageno", String(input.pageno))
  if (input.safesearch !== undefined) params.set("safesearch", String(input.safesearch))
  return `${base}/search?${params.toString()}`
}

function looksLikeHtml(body: string): boolean {
  return /^\s*<(!doctype|html|head|body)/i.test(body) || /<html[\s>]/i.test(body)
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Validate and normalize the decoded JSON payload. */
export function parseSearchPayload(payload: unknown): SearxngResult[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SearxngError("SearXNG returned JSON that is not an object.", { code: "INVALID_RESPONSE" })
  }
  const results = (payload as { results?: unknown }).results
  if (results === undefined) return []
  if (!Array.isArray(results)) {
    throw new SearxngError("SearXNG response is missing a `results` array.", { code: "INVALID_RESPONSE" })
  }

  const normalized: SearxngResult[] = []
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const url = asNonEmptyString(record.url)
    if (url === undefined) continue

    const result: SearxngResult = {
      url,
      title: typeof record.title === "string" ? record.title : "",
      content: typeof record.content === "string" ? record.content : "",
    }
    const engine = asNonEmptyString(record.engine)
    if (engine !== undefined) result.engine = engine
    if (typeof record.score === "number" && Number.isFinite(record.score)) result.score = record.score
    normalized.push(result)
  }
  return normalized
}

/**
 * Query a SearXNG instance and return normalized results.
 *
 * Never throws a raw parse/network error: every failure is wrapped in a
 * {@link SearxngError} with an actionable message. `AbortError` from the
 * supplied `signal` is rethrown untouched so callers can detect cancellation.
 */
export async function searchSearxng(options: SearxngSearchOptions): Promise<SearxngResult[]> {
  const query = asNonEmptyString(options.query)
  if (query === undefined) {
    throw new SearxngError("SearXNG search requires a non-empty `query`.", { code: "INVALID_RESPONSE" })
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const maxResults = asPositiveInt(options.maxResults) ?? DEFAULT_MAX_RESULTS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  const url = buildSearchUrl({
    baseUrl,
    query,
    ...(options.categories !== undefined ? { categories: options.categories } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.timeRange !== undefined ? { timeRange: options.timeRange } : {}),
    ...(options.pageno !== undefined ? { pageno: options.pageno } : {}),
    ...(options.safesearch !== undefined ? { safesearch: options.safesearch } : {}),
  })

  const headers: Record<string, string> = { Accept: "application/json" }
  if (options.token !== undefined && options.token !== "") {
    headers.Authorization = `Bearer ${options.token}`
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new SearxngError(
      `Failed to reach SearXNG at ${baseUrl}: ${errorMessage(error)}. ` +
        `Check that the instance is running and SEARXNG_URL is correct.`,
      { code: "NETWORK", cause: error },
    )
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new SearxngError(
        `SearXNG at ${baseUrl} rejected the JSON API request (HTTP 403). ` +
          `The JSON output format is disabled: add "json" to search.formats in the instance settings.yml ` +
          `and restart SearXNG.`,
        { code: "HTTP_ERROR", status: 403 },
      )
    }
    throw new SearxngError(
      `SearXNG request to ${baseUrl} failed with HTTP ${response.status} ${response.statusText}`.trim() + ".",
      { code: "HTTP_ERROR", status: response.status },
    )
  }

  const raw = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    const hint = looksLikeHtml(raw)
      ? " The instance returned HTML (a captcha or error page) instead of JSON; ensure format=json is enabled and the instance is reachable without a browser challenge."
      : " The response body was not valid JSON; ensure format=json is enabled on the instance."
    throw new SearxngError(
      `SearXNG returned a non-JSON response (HTTP ${response.status}).${hint}`,
      { code: "NON_JSON", status: response.status, cause: error },
    )
  }

  const results = parseSearchPayload(payload)
  return results.slice(0, maxResults)
}

/** Render results as plain text for tool output. */
export function formatResults(results: readonly SearxngResult[]): string {
  if (results.length === 0) return "No results found."
  return results
    .map((result, index) => {
      const parts = [`${index + 1}. ${result.title || result.url}`, result.url]
      if (result.content) parts.push(result.content)
      return parts.join("\n")
    })
    .join("\n\n")
}
