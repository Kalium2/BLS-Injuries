/**
 * BLS Injuries Worker
 * -------------------
 * A small Cloudflare Worker that fetches occupational injury and illness data
 * from the BLS Public Data API, keeping your API key out of the browser.
 *
 * Setup:
 *   1. wrangler secret put BLS_API_KEY     <- paste your key when prompted
 *   2. wrangler deploy
 *
 * Endpoints:
 *
 *   GET /series?id=ISU00000000031100&start=2015&end=2024
 *       Fetch any BLS series by its exact ID. Works immediately.
 *
 *   GET /rate?naics=236&year=2024&state=CA
 *       Friendly version. Needs NAICS_SERIES filled in (see below).
 *
 *   GET /health
 *       Quick check that the Worker is alive and the key is set.
 */

const BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

// Only these sites may call the Worker from a browser.
const ALLOWED_ORIGINS = [
  "https://kalium2.github.io",
  "http://localhost:8787",
];

// Annual data, so cache hard. 7 days.
const CACHE_SECONDS = 60 * 60 * 24 * 7;

// ---------------------------------------------------------------------------
// NAICS -> BLS codes.
//
// Build this from BLS's own "is.series" file. Until it's filled in, the
// /rate endpoint will tell you which NAICS codes it knows about.
//
// Format:  "naics": { ss: "<3-digit supersector>", ind: "<6-digit industry>" }
// ---------------------------------------------------------------------------
const NAICS_SERIES = {
  // "236": { ss: "200", ind: "236000" },
  // "311": { ss: "300", ind: "311000" },
};

// Two-digit state codes used in the BLS area field. 00 means national.
const STATE_CODES = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17",
  IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24",
  MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31",
  NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
  OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46",
  TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56",
};

// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      ...corsHeaders(origin),
    },
  });
}

/**
 * Assemble a 17-character SOII industry series ID.
 *   dataType "3" = rate of injury and illness cases per 100 full-time workers
 *   caseType "1" = total recordable cases
 *   area "100"   = private industry, national
 */
function buildSeriesId(opts) {
  const supersector = opts.supersector;
  const industry = opts.industry;
  const dataType = opts.dataType || "3";
  const caseType = opts.caseType || "1";
  const area = opts.area || "100";
  return "ISU" + supersector + industry + dataType + caseType + area;
}

/** Walk 236111 -> 23611 -> 2361 -> 236 -> 23 until the lookup has a match. */
function findNaicsEntry(naics) {
  let code = String(naics).replace(/\D/g, "");
  while (code.length >= 2) {
    if (NAICS_SERIES[code]) {
      return { matched: code, ...NAICS_SERIES[code] };
    }
    code = code.slice(0, -1);
  }
  return null;
}

async function fetchSeries(seriesIds, startYear, endYear, apiKey) {
  const payload = {
    seriesid: seriesIds,
    startyear: String(startYear),
    endyear: String(endYear),
    registrationkey: apiKey,
    catalog: true,
  };

  const res = await fetch(BLS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`BLS returned HTTP ${res.status}`);
  }

  const data = await res.json();

  // BLS always returns 200 OK. Real errors live in the body.
  if (data.status !== "REQUEST_SUCCEEDED") {
    const detail = (data.message || []).join(" ") || "unknown BLS error";
    throw new Error(detail);
  }

  return data.Results.series || [];
}

/** Flatten BLS's nested response into something a UI can render directly. */
function tidySeries(series) {
  return series.map((s) => ({
    seriesId: s.seriesID,
    title: s.catalog ? s.catalog.series_title : null,
    observations: (s.data || [])
      .map((d) => ({
        year: Number(d.year),
        value: d.value === "-" ? null : Number(d.value),
        footnotes: (d.footnotes || [])
          .map((f) => f.text)
          .filter(Boolean),
      }))
      .sort((a, b) => a.year - b.year),
  }));
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "Only GET is supported." }, 405, origin);
    }

    if (path === "/health") {
      return json(
        {
          ok: true,
          keyConfigured: Boolean(env.BLS_API_KEY),
          naicsCodesLoaded: Object.keys(NAICS_SERIES).length,
        },
        200,
        origin
      );
    }

    if (!env.BLS_API_KEY) {
      return json(
        { error: "BLS_API_KEY is not set. Run: wrangler secret put BLS_API_KEY" },
        500,
        origin
      );
    }

    // Serve from Cloudflare's cache when we can.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const thisYear = new Date().getUTCFullYear();

    try {
      let seriesIds;
      let meta = {};

      if (path === "/series") {
        const id = (url.searchParams.get("id") || "").toUpperCase().trim();
        if (!/^[A-Z0-9]{10,20}$/.test(id)) {
          return json({ error: "Pass a valid BLS series ID as ?id=" }, 400, origin);
        }
        seriesIds = [id];
      } else if (path === "/rate") {
        const naics = url.searchParams.get("naics");
        if (!naics) {
          return json({ error: "Pass ?naics= (for example 236)." }, 400, origin);
        }

        const entry = findNaicsEntry(naics);
        if (!entry) {
          return json(
            {
              error: `No BLS industry mapping for NAICS ${naics}.`,
              hint: "Fill in NAICS_SERIES in the Worker from BLS's is.series file.",
              known: Object.keys(NAICS_SERIES),
            },
            404,
            origin
          );
        }

        const stateParam = (url.searchParams.get("state") || "").toUpperCase();
        const stateCode = stateParam ? STATE_CODES[stateParam] : "00";
        if (stateParam && !stateCode) {
          return json({ error: `Unknown state code: ${stateParam}` }, 400, origin);
        }

        seriesIds = [
          buildSeriesId({
            supersector: entry.ss,
            industry: entry.ind,
            dataType: url.searchParams.get("dataType") || "3",
            caseType: url.searchParams.get("caseType") || "1",
            area: "1" + stateCode,
          }),
        ];

        meta = {
          naicsRequested: naics,
          naicsMatched: entry.matched,
          state: stateParam || "national",
        };
      } else {
        return json(
          { error: "Not found.", endpoints: ["/series", "/rate", "/health"] },
          404,
          origin
        );
      }

      // BLS allows a 20-year window per query.
      const year = url.searchParams.get("year");
      const start = Number(url.searchParams.get("start")) || (year ? Number(year) : thisYear - 10);
      const end = Number(url.searchParams.get("end")) || (year ? Number(year) : thisYear);

      const raw = await fetchSeries(seriesIds, start, end, env.BLS_API_KEY);
      const series = tidySeries(raw);

      const response = json(
        {
          source: "U.S. Bureau of Labor Statistics, Survey of Occupational Injuries and Illnesses",
          note: "Industry-level survey estimate, not a figure for any individual employer.",
          requested: { start, end, seriesIds, ...meta },
          series,
        },
        200,
        origin
      );

      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch (err) {
      return json({ error: String(err.message || err) }, 502, origin);
    }
  },
};
