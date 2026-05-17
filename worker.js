/**
 * Cloudflare Worker variant of index.php. Resolves a Google Maps list URL or
 * ID and returns the same { title, items } JSON the frontend expects.
 *
 * Deploy:
 *   1. Cloudflare dashboard -> Workers & Pages -> Create -> Hello World worker
 *   2. Paste this file's contents, deploy
 *   3. Note the URL, e.g. https://route-proxy.<account>.workers.dev
 *   4. In script.js set PROXY_URL = 'https://route-proxy.<account>.workers.dev/load'
 *
 * Or with wrangler:
 *   npx wrangler deploy worker.js --name route-proxy
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (url.pathname !== '/load') {
      return new Response('Route Optimizer proxy. Use /load?url=<google-maps-list-url>', {
        status: 200,
        headers: cors,
      });
    }
    const input = (url.searchParams.get('url') || '').trim();
    const refresh = url.searchParams.get('refresh') === '1';
    if (!input) return jsonError('Geen URL of lijst-ID opgegeven.', cors);
    try {
      const listId = await resolveListId(input);
      const cache = caches.default;
      const cacheKey = new Request(`https://cache.route.vdhout.cc/list/${listId}`);
      if (!refresh) {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const r = new Response(hit.body, hit);
          for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
          r.headers.set('X-Cache', 'HIT');
          return r;
        }
      }
      const payload = await fetchList(listId);
      const body = JSON.stringify(payload);
      const fresh = new Response(body, {
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Cache-Control': 'public, s-maxage=86400, max-age=300',
          'X-Cache': 'MISS',
          ...cors,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
      return fresh;
    } catch (e) {
      return jsonError(e.message || String(e), cors);
    }
  },
};

/**
 * Returns a JSON error response with CORS headers.
 *
 * @param {string} msg
 * @param {Record<string,string>} headers
 * @returns {Response}
 */
function jsonError(msg, headers) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json;charset=utf-8', ...headers },
  });
}

/**
 * Resolves a Google Maps URL or raw ID to a list ID.
 *
 * @param {string} input
 * @returns {Promise<string>}
 */
async function resolveListId(input) {
  if (/^[A-Za-z0-9_-]{20,}$/.test(input)) return input;
  if (!/^https?:\/\//i.test(input)) throw new Error('Plak een Google Maps lijst-URL of lijst-ID.');
  const res = await fetch(input, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    redirect: 'follow',
  });
  const body = await res.text();
  let m = body.match(/\/placelists\/list\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = res.url.match(/!2s([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  throw new Error('Kon geen lijst-ID vinden in deze URL.');
}

/**
 * Calls Google's entitylist/getlist endpoint and extracts items.
 *
 * @param {string} listId
 * @returns {Promise<{title:string, items:Array<{name:string,lat:number,lng:number,address:?string}>}>}
 */
async function fetchList(listId) {
  const pb = `!1m4!1s${listId}!2e1!3m1!1e1!2e2!3e2!4i500`;
  const url = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=nl&gl=nl&pb=${encodeURIComponent(pb)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  };
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, { headers });
    if (res.status !== 429 && res.status !== 503) break;
    await new Promise((r) => setTimeout(r, 200 + attempt * 300));
  }
  if (!res.ok) throw new Error('Google gaf status ' + res.status);
  let raw = await res.text();
  if (raw.startsWith(")]}'")) raw = raw.substring(raw.indexOf('\n') + 1);
  const data = JSON.parse(raw);
  const title = String(data?.[0]?.[4] ?? '');
  const rawItems = data?.[0]?.[8] ?? [];
  if (!Array.isArray(rawItems)) throw new Error('Lijst is leeg of niet leesbaar.');
  const items = [];
  for (const it of rawItems) {
    const coordsBlk = it?.[1]?.[5];
    const name = String(it?.[2] ?? '');
    if (!Array.isArray(coordsBlk) || coordsBlk.length < 4) continue;
    const lat = coordsBlk[2];
    const lng = coordsBlk[3];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const address = typeof it?.[1]?.[4] === 'string' && it[1][4] !== '' ? it[1][4] : null;
    items.push({ name: name || 'Onbekend', lat, lng, address });
  }
  if (!items.length) throw new Error('Geen plekken met coördinaten gevonden in de lijst.');
  return { title, items };
}
