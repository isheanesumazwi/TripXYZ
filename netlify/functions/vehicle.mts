import type { Config } from "@netlify/functions"
import vehicleLib from "../../lib/vehicle.js"

const DEFAULT_ORIGINS = "https://isheanesumazwi.github.io"

let vehicles: ReturnType<typeof vehicleLib.createVehicleLookup> | undefined

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  })

export default async (req: Request) => {
  const allowed = (Netlify.env.get("ALLOWED_ORIGINS") || DEFAULT_ORIGINS).split(",").map((o) => o.trim())
  const origin = req.headers.get("origin") || ""
  if (!allowed.includes(origin)) return json(403, { error: "This API only serves the TripXYZ website." }, {})

  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })

  vehicles ??= vehicleLib.createVehicleLookup((key: string) => Netlify.env.get(key))
  const url = new URL(req.url)

  if (url.pathname === "/api/config") return json(200, { vehicleLookup: vehicles.enabled }, cors)

  const { status, body } = await vehicles.lookup(url.searchParams.get("reg"))
  return json(status, body, cors)
}

export const config: Config = {
  path: ["/api/vehicle", "/api/config"],
  method: ["GET", "OPTIONS"],
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
}
