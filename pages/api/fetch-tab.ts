import type { NextApiRequest, NextApiResponse } from "next"
import {
  extractTabFromHtml,
  isUltimateGuitarUrl,
  normalizeUltimateGuitarUrl,
  type UltimateGuitarTab,
} from "../../lib/ultimate-guitar"

const FETCH_TIMEOUT_MS = 12000

const REQUEST_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchFromTabPage(tabUrl: string): Promise<UltimateGuitarTab> {
  const response = await fetchWithTimeout(tabUrl, { headers: REQUEST_HEADERS })
  if (!response.ok) throw new Error(`tab page responded ${response.status}`)

  const tab = extractTabFromHtml(await response.text())
  if (!tab) throw new Error("tab page did not contain chord data")
  return tab
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET")
    return res.status(405).json({ error: "Method not allowed" })
  }

  const rawUrl = typeof req.query.url === "string" ? req.query.url : ""
  if (!isUltimateGuitarUrl(rawUrl)) {
    return res.status(400).json({ error: "Please provide an Ultimate Guitar tab URL." })
  }

  const tabUrl = normalizeUltimateGuitarUrl(rawUrl)

  try {
    const tab = await fetchFromTabPage(tabUrl)
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800")
    return res.status(200).json(tab)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("fetch-tab failed for", tabUrl, message)
    return res.status(502).json({
      error: "Could not load chords from Ultimate Guitar.",
      details: message,
    })
  }
}
