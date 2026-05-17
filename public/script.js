/**
 * Route optimizer SPA. Loads a Google Maps list via the server proxy,
 * optimizes the visiting order with the public OSRM /trip service, draws
 * the result on Leaflet and exports it to Google Maps directions.
 */

// Hostname of the Worker that handles /load. Empty = same-origin (the
// Worker also serves this page via Workers Static Assets).
const PROXY_HOST = '';

const OSRM_HOSTS = {
  driving: 'https://routing.openstreetmap.de/routed-car',
  cycling: 'https://routing.openstreetmap.de/routed-bike',
  walking: 'https://routing.openstreetmap.de/routed-foot',
};
const GMAPS_TRAVELMODE = {
  driving: 'driving',
  cycling: 'bicycling',
  walking: 'walking',
};
const STORAGE_URL = 'route.lastUrl';
const STORAGE_MODE = 'route.mode';
const STORAGE_RECENTS = 'route.recents';
const MAX_RECENTS = 8;

const state = {
  places: [],
  title: '',
  startCoord: null,
  ordered: [],
  routeKm: 0,
  routeMin: 0,
};

const map = L.map('map').setView([52.1, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

let markersLayer = L.layerGroup().addTo(map);
let routeLayer = L.layerGroup().addTo(map);

const $ = (id) => document.getElementById(id);
const urlInput = $('list-url');
const btnLoad = $('btn-load');
const loadMsg = $('load-msg');
const stepOptions = $('step-options');
const listTitle = $('list-title');
const placeList = $('place-list');
const optCurrent = $('opt-current');
const optRoundtrip = $('opt-roundtrip');
const btnShortest = $('btn-shortest');
const btnLongestTop = $('btn-longest-top');
const optMsg = $('opt-msg');
const stepResult = $('step-result');
const stats = $('stats');
const routeList = $('route-list');
const btnReverse = $('btn-reverse');
const partsList = $('parts-list');
const btnReset = $('btn-reset');
const resultMsg = $('result-msg');
const recentsEl = $('recents');

const savedUrl = localStorage.getItem(STORAGE_URL);
if (savedUrl) urlInput.value = savedUrl;
const savedMode = localStorage.getItem(STORAGE_MODE);
if (savedMode) {
  const radio = document.querySelector(`input[name="mode"][value="${savedMode}"]`);
  if (radio) radio.checked = true;
}

btnLoad.addEventListener('click', loadList);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(); });
btnShortest.addEventListener('click', () => runCompute(false));
btnLongestTop.addEventListener('click', () => runCompute(true));
btnReverse.addEventListener('click', reverseRoute);
btnReset.addEventListener('click', reset);

renderRecents();
loadFromHash();
initPanelToggle();

/**
 * Wires up the mobile-only "fullscreen map" toggle on the map wrapper.
 *
 * @returns {void}
 */
function initPanelToggle() {
  const btn = document.getElementById('panel-toggle');
  const app = document.querySelector('.app');
  if (!btn || !app) return;
  btn.addEventListener('click', () => {
    app.classList.toggle('map-only');
    setTimeout(() => map.invalidateSize(), 250);
  });
}

/**
 * Fetches the list from the PHP proxy and renders the unoptimized places.
 *
 * @returns {Promise<void>}
 */
async function loadList() {
  const url = urlInput.value.trim();
  if (!url) {
    setMsg(loadMsg, 'Plak een Google Maps lijst-URL.', 'error');
    return;
  }
  btnLoad.disabled = true;
  setMsg(loadMsg, 'Bezig met laden...');
  try {
    const res = await fetch(`${PROXY_HOST}/load?url=` + encodeURIComponent(url));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Onbekende fout');
    state.places = data.items;
    state.title = data.title || 'Lijst';
    listTitle.textContent = `${state.title} (${state.places.length} plekken)`;
    renderPlaceList();
    drawUnordered();
    fitMap();
    stepOptions.classList.remove('hidden');
    stepResult.classList.add('hidden');
    state.ordered = [];
    localStorage.setItem(STORAGE_URL, url);
    saveRecent({ url, title: state.title, items: state.places });
    setMsg(loadMsg, `Geladen: ${state.places.length} plekken.`, 'ok');
  } catch (e) {
    setMsg(loadMsg, e.message, 'error');
  } finally {
    btnLoad.disabled = false;
  }
}

/**
 * Renders the unordered place list in the sidebar.
 *
 * @returns {void}
 */
function renderPlaceList() {
  placeList.innerHTML = '';
  state.places.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${i + 1}</span><span><span class="name">${escapeHtml(p.name)}</span></span>`;
    placeList.appendChild(li);
  });
}

/**
 * Draws unordered markers on the map.
 *
 * @returns {void}
 */
function drawUnordered() {
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  state.places.forEach((p, i) => {
    L.marker([p.lat, p.lng], { icon: numIcon(i + 1, 'unordered') })
      .bindPopup(escapeHtml(p.name))
      .addTo(markersLayer);
  });
}

/**
 * Re-centers the map to fit all currently shown markers/route.
 *
 * @returns {void}
 */
function fitMap() {
  const bounds = [];
  markersLayer.eachLayer((m) => bounds.push(m.getLatLng()));
  routeLayer.eachLayer((l) => {
    if (l.getBounds) bounds.push(l.getBounds().getNorthEast(), l.getBounds().getSouthWest());
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
}

/**
 * Computes either the shortest or longest route through state.places.
 *
 * @param {boolean} maximize
 * @returns {Promise<void>}
 */
async function runCompute(maximize) {
  btnShortest.disabled = btnLongestTop.disabled = true;
  setMsg(optMsg, 'Bezig met optimaliseren...');
  try {
    let startCoord = null;
    if (optCurrent.checked) {
      setMsg(optMsg, 'Locatie ophalen...');
      startCoord = await getCurrentLocation();
    }
    state.startCoord = startCoord;

    const allStops = [];
    if (startCoord) {
      allStops.push({ kind: 'start', name: 'Huidige locatie', lat: startCoord[0], lng: startCoord[1] });
    }
    state.places.forEach((p) => {
      allStops.push({ kind: 'place', name: p.name, lat: p.lat, lng: p.lng });
    });

    const useCurrent = !!startCoord;
    const roundtrip = optRoundtrip.checked;
    const mode = getMode();
    localStorage.setItem(STORAGE_MODE, mode);

    if (maximize) {
      await computeLongest(allStops, useCurrent, roundtrip, mode);
    } else {
      await computeShortest(allStops, useCurrent, roundtrip, mode);
    }
    stepResult.classList.remove('hidden');
    setMsg(optMsg, 'Klaar.', 'ok');
  } catch (e) {
    setMsg(optMsg, e.message, 'error');
  } finally {
    btnShortest.disabled = btnLongestTop.disabled = false;
  }
}

/**
 * Shortest TSP via OSRM /trip. Mutates state.ordered, state.routeKm/Min and
 * calls renderResult with the geometry.
 *
 * @param {Array<{kind:string,name:string,lat:number,lng:number}>} allStops
 * @param {boolean} useCurrent
 * @param {boolean} roundtrip
 * @param {string} mode
 * @returns {Promise<void>}
 */
async function computeShortest(allStops, useCurrent, roundtrip, mode) {
  const params = new URLSearchParams({ overview: 'full', geometries: 'geojson', roundtrip: 'true' });
  if (useCurrent) params.set('source', 'first');
  const coordStr = allStops.map((s) => `${s.lng},${s.lat}`).join(';');
  const url = `${OSRM_HOSTS[mode]}/trip/v1/driving/${coordStr}?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM trip: ' + (data.message || data.code));
  const trip = data.trips[0];
  const ordered = data.waypoints
    .map((w, originalIndex) => ({ originalIndex, order: w.waypoint_index }))
    .sort((a, b) => a.order - b.order)
    .map((w) => ({ ...allStops[w.originalIndex] }));

  const legs = trip.legs.slice();
  let geometry = trip.geometry.coordinates.map(([ln, la]) => [la, ln]);
  if (!roundtrip) {
    if (legs.length) legs.pop();
    geometry = dropClosingGeometry(geometry, ordered[0]);
  } else {
    ordered.push({ ...ordered[0], closing: true });
  }
  state.ordered = ordered;
  state.routeKm = legs.reduce((s, l) => s + l.distance, 0) / 1000;
  state.routeMin = legs.reduce((s, l) => s + l.duration, 0) / 60;
  renderResult(geometry);
}

/**
 * Longest path via OSRM /table + greedy farthest + 2-opt-maximize, then
 * fetches the geometry via /route.
 *
 * @param {Array<{kind:string,name:string,lat:number,lng:number}>} allStops
 * @param {boolean} useCurrent
 * @param {boolean} roundtrip
 * @param {string} mode
 * @returns {Promise<void>}
 */
async function computeLongest(allStops, useCurrent, roundtrip, mode) {
  const coordStr = allStops.map((s) => `${s.lng},${s.lat}`).join(';');
  const res = await fetch(`${OSRM_HOSTS[mode]}/table/v1/driving/${coordStr}?annotations=distance`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM table: ' + (data.message || data.code));
  const M = data.distances;
  const N = allStops.length;
  let path;
  if (useCurrent) {
    path = twoOptMaximize(M, greedyFarthest(M, N, 0), true, roundtrip);
  } else {
    let bestTotal = -Infinity;
    for (let s = 0; s < N; s++) {
      const candidate = twoOptMaximize(M, greedyFarthest(M, N, s), false, roundtrip);
      const t = pathTotal(M, candidate, roundtrip);
      if (t > bestTotal) { bestTotal = t; path = candidate; }
    }
  }
  const ordered = path.map((idx) => ({ ...allStops[idx] }));
  if (roundtrip) ordered.push({ ...ordered[0], closing: true });
  state.ordered = ordered;
  await refreshRouteGeometry('Tekening ophalen...');
}

/**
 * For open routes: trims the closing portion of the geometry that returns
 * to the start point so the drawn line ends at the last visited stop.
 *
 * @param {Array<[number,number]>} geometry  lat/lng pairs
 * @param {{lat:number,lng:number}} start
 * @returns {Array<[number,number]>}
 */
function dropClosingGeometry(geometry, start) {
  if (geometry.length < 2) return geometry;
  let bestIdx = geometry.length - 1;
  let bestDist = Infinity;
  for (let i = Math.floor(geometry.length * 0.5); i < geometry.length; i++) {
    const d = haversine(geometry[i], [start.lat, start.lng]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  let cutFrom = bestIdx;
  for (let i = bestIdx; i > 0; i--) {
    if (haversine(geometry[i], [start.lat, start.lng]) > bestDist + 0.05) break;
    cutFrom = i;
  }
  return geometry.slice(0, cutFrom + 1);
}

/**
 * Haversine distance in km between two [lat,lng] points.
 *
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @returns {number}
 */
function haversine(a, b) {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]);
  const la2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Renders the optimized result: ordered list, stats, map markers and polyline.
 *
 * @param {Array<[number,number]>} geometry
 * @returns {void}
 */
function renderResult(geometry) {
  renderParts();
  saveStateToHash();
  routeList.innerHTML = '';
  state.ordered.forEach((stop, i) => {
    if (stop.closing) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${i + 1}</span><span><span class="name">${escapeHtml(stop.name)}</span></span>`;
    routeList.appendChild(li);
  });

  stats.innerHTML = `<strong>${state.routeKm.toFixed(1)} km</strong> · ca. <strong>${formatDuration(state.routeMin)}</strong> rijden`;

  markersLayer.clearLayers();
  routeLayer.clearLayers();
  const visibleStops = state.ordered.filter((s) => !s.closing);
  visibleStops.forEach((stop, i) => {
    let role = 'unordered';
    if (i === 0) role = 'start';
    else if (i === visibleStops.length - 1 && (optRoundtrip.checked || stop.kind === 'end')) role = 'end';
    L.marker([stop.lat, stop.lng], { icon: numIcon(i + 1, role) })
      .bindPopup(escapeHtml(stop.name))
      .addTo(markersLayer);
  });
  L.polyline(geometry, { color: '#2f6fed', weight: 5, opacity: 0.85 }).addTo(routeLayer);
  fitMap();
}

/**
 * Resets the UI back to the initial state.
 *
 * @returns {void}
 */
function reset() {
  state.places = [];
  state.ordered = [];
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  stepOptions.classList.add('hidden');
  stepResult.classList.add('hidden');
  setMsg(loadMsg, '');
  history.replaceState(null, '', location.pathname + location.search);
  map.setView([52.1, 5.3], 7);
}

/**
 * Encodes the current route into a URL fragment so the page can be bookmarked
 * and reopened later (e.g. to navigate part 2 of a split route).
 *
 * @returns {void}
 */
function saveStateToHash() {
  const visible = state.ordered.filter((s) => !s.closing);
  if (visible.length < 2) return;
  const data = {
    v: 1,
    m: getMode(),
    r: !!optRoundtrip.checked,
    s: visible.map((s) => ({
      n: s.name,
      a: +s.lat.toFixed(6),
      o: +s.lng.toFixed(6),
      k: s.kind === 'start' ? 'start' : 'place',
    })),
  };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  history.replaceState(null, '', `#r=${b64}`);
}

/**
 * If the URL fragment contains a saved route, restores state and draws it.
 *
 * @returns {Promise<boolean>}
 */
async function loadFromHash() {
  const m = location.hash.match(/^#r=([A-Za-z0-9_\-]+)/);
  if (!m) return false;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const data = JSON.parse(json);
    if (data.v !== 1 || !Array.isArray(data.s) || data.s.length < 2) return false;
    const modeRadio = document.querySelector(`input[name="mode"][value="${data.m}"]`);
    if (modeRadio) modeRadio.checked = true;
    optRoundtrip.checked = !!data.r;
    const hasCurrent = data.s[0] && data.s[0].k === 'start';
    optCurrent.checked = hasCurrent;
    state.startCoord = hasCurrent ? [data.s[0].a, data.s[0].o] : null;

    const stops = data.s.map((x) => ({
      kind: x.k || 'place',
      name: x.n,
      lat: x.a,
      lng: x.o,
    }));
    state.ordered = stops.slice();
    if (optRoundtrip.checked) state.ordered.push({ ...stops[0], closing: true });
    state.places = stops.filter((s) => s.kind !== 'start').map((s) => ({
      name: s.name, lat: s.lat, lng: s.lng, address: null,
    }));
    state.title = 'Hersteld uit link';
    listTitle.textContent = `${state.title} (${state.places.length} plekken)`;
    renderPlaceList();
    stepOptions.classList.remove('hidden');
    stepResult.classList.remove('hidden');
    await refreshRouteGeometry('Route herstellen...');
    setMsg(loadMsg, 'Route hersteld uit link.', 'ok');
    return true;
  } catch (e) {
    setMsg(loadMsg, 'Opgeslagen link is corrupt: ' + e.message, 'error');
    return false;
  }
}

/**
 * Renders the per-part Open/Copy buttons. Splits the route into Google-Maps-
 * friendly chunks (max 11 stops per URL: 1 origin + 9 waypoints + 1 destination)
 * with 1-stop overlap so navigation continues seamlessly.
 *
 * @returns {void}
 */
function renderParts() {
  partsList.innerHTML = '';
  const stops = state.ordered.filter((s) => !s.closing).slice();
  if (stops.length < 2) return;
  if (optRoundtrip.checked) stops.push(stops[0]);
  const chunks = chunkWithOverlap(stops, 11);
  chunks.forEach((chunk, i) => {
    const url = buildGoogleMapsUrlForStops(chunk);
    const isSingle = chunks.length === 1;
    const label = isSingle
      ? `Hele route <small>${chunk.length} stops: ${escapeHtml(chunk[0].name)} → ${escapeHtml(chunk[chunk.length - 1].name)}</small>`
      : `Deel ${i + 1} van ${chunks.length} <small>${chunk.length} stops: ${escapeHtml(chunk[0].name)} → ${escapeHtml(chunk[chunk.length - 1].name)}</small>`;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="label">${label}</div>
      <div class="row-actions">
        <button class="primary" data-action="open">Open in Google Maps</button>
        <button data-action="copy">Kopieer link</button>
      </div>`;
    row.querySelector('[data-action="open"]').addEventListener('click', () => window.open(url, '_blank'));
    row.querySelector('[data-action="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        setMsg(resultMsg, `Link voor ${isSingle ? 'route' : `deel ${i + 1}`} gekopieerd.`, 'ok');
      } catch {
        setMsg(resultMsg, url, 'ok');
      }
    });
    partsList.appendChild(row);
  });
}

/**
 * Splits an array into overlapping chunks where each chunk has at most
 * `maxSize` items and consecutive chunks share their boundary element.
 * Chunks are balanced to be as equal in size as possible (e.g. 17 items with
 * maxSize 11 splits as 9 + 9, not 11 + 7).
 *
 * @template T
 * @param {T[]} arr
 * @param {number} maxSize
 * @returns {T[][]}
 */
function chunkWithOverlap(arr, maxSize) {
  const N = arr.length;
  if (N <= maxSize) return [arr.slice()];
  const numChunks = Math.ceil((N - 1) / (maxSize - 1));
  const newPerChunk = (N - 1) / numChunks;
  const chunks = [];
  let start = 0;
  for (let i = 0; i < numChunks; i++) {
    const newCount = Math.round(newPerChunk * (i + 1)) - Math.round(newPerChunk * i);
    const end = start + newCount + 1;
    chunks.push(arr.slice(start, end));
    start = end - 1;
  }
  return chunks;
}

/**
 * Builds a Google Maps directions URL from a concrete list of stops
 * (first = origin, last = destination, middle = waypoints).
 *
 * @param {Array<{lat:number,lng:number}>} stops
 * @returns {string}
 */
function buildGoogleMapsUrlForStops(stops) {
  if (stops.length < 2) return '';
  const fmt = (s) => `${s.lat},${s.lng}`;
  const params = new URLSearchParams({
    api: '1',
    origin: fmt(stops[0]),
    destination: fmt(stops[stops.length - 1]),
    travelmode: GMAPS_TRAVELMODE[getMode()] || 'driving',
  });
  if (stops.length > 2) {
    params.set('waypoints', stops.slice(1, -1).map(fmt).join('|'));
  }
  return 'https://www.google.com/maps/dir/?' + params.toString();
}

/**
 * Reverses the current visit order and redraws the route. A fixed start
 * (current location) is kept in place; the rest is flipped.
 *
 * @returns {Promise<void>}
 */
async function reverseRoute() {
  const stops = state.ordered.filter((s) => !s.closing);
  if (stops.length < 2) return;
  const fixFirst = !!state.startCoord && stops[0].kind === 'start';
  if (fixFirst) {
    const [head, ...rest] = stops;
    state.ordered = [head, ...rest.reverse()];
  } else {
    state.ordered = stops.slice().reverse();
  }
  await refreshRouteGeometry('Omdraaien...');
}

/**
 * Greedy seed: starting from `start`, always go to the farthest unvisited.
 *
 * @param {number[][]} M  N x N distance matrix
 * @param {number} N
 * @param {number} start
 * @returns {number[]}
 */
function greedyFarthest(M, N, start) {
  const visited = new Set([start]);
  const path = [start];
  while (path.length < N) {
    const cur = path[path.length - 1];
    let bestI = -1, bestD = -1;
    for (let i = 0; i < N; i++) {
      if (visited.has(i)) continue;
      const d = M[cur][i] ?? 0;
      if (d > bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0) break;
    path.push(bestI);
    visited.add(bestI);
  }
  return path;
}

/**
 * 2-opt local search that flips segments while total distance strictly
 * increases. Respects whether the first index is fixed and whether the
 * route is a cycle.
 *
 * @param {number[][]} M
 * @param {number[]} path
 * @param {boolean} fixFirst
 * @param {boolean} cycle
 * @returns {number[]}
 */
function twoOptMaximize(M, path, fixFirst, cycle) {
  const total = (p) => {
    let s = 0;
    for (let i = 0; i + 1 < p.length; i++) s += M[p[i]][p[i + 1]] ?? 0;
    if (cycle) s += M[p[p.length - 1]][p[0]] ?? 0;
    return s;
  };
  let best = path.slice();
  let bestD = total(best);
  let improved = true;
  let safety = 200;
  while (improved && safety-- > 0) {
    improved = false;
    for (let i = fixFirst ? 1 : 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const d = total(candidate);
        if (d > bestD + 1e-6) {
          best = candidate; bestD = d; improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Calls OSRM /route through the current ordered stops and re-renders.
 *
 * @param {string} progressMsg
 * @returns {Promise<void>}
 */
async function refreshRouteGeometry(progressMsg) {
  setMsg(resultMsg, progressMsg);
  const stops = state.ordered.filter((s) => !s.closing);
  const coords = stops.map((s) => [s.lat, s.lng]);
  if (optRoundtrip.checked) coords.push(coords[0]);
  const mode = getMode();
  const coordStr = coords.map(([la, ln]) => `${ln},${la}`).join(';');
  const url = `${OSRM_HOSTS[mode]}/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM route: ' + (data.message || data.code));
  const route = data.routes[0];
  const geometry = route.geometry.coordinates.map(([ln, la]) => [la, ln]);
  state.routeKm = route.distance / 1000;
  state.routeMin = route.duration / 60;
  renderResult(geometry);
  setMsg(resultMsg, '', '');
}

/**
 * Reads the currently selected transport mode.
 *
 * @returns {string}
 */
function getMode() {
  const sel = document.querySelector('input[name="mode"]:checked');
  return sel ? sel.value : 'driving';
}

/**
 * Wraps navigator.geolocation in a promise returning [lat, lng].
 *
 * @returns {Promise<[number,number]>}
 */
function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocatie niet ondersteund.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      (err) => reject(new Error('Locatie ophalen mislukt: ' + err.message)),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

/**
 * Creates a Leaflet numbered DivIcon.
 *
 * @param {number} n
 * @param {string} role  one of 'start', 'end', 'unordered', ''
 * @returns {L.DivIcon}
 */
function numIcon(n, role) {
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${role}">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/**
 * Formats minutes as "1u 23m" or "23m".
 *
 * @param {number} min
 * @returns {string}
 */
function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}u ${m}m` : `${m}m`;
}

/**
 * Sets a message on a hint element with optional state class.
 *
 * @param {HTMLElement} el
 * @param {string} text
 * @param {string} [cls]  'error' | 'ok' | ''
 * @returns {void}
 */
function setMsg(el, text, cls = '') {
  el.textContent = text;
  el.className = 'hint' + (cls ? ' ' + cls : '');
}

/**
 * Minimal HTML-escape for text inserted via innerHTML.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Reads the recents list from localStorage.
 *
 * @returns {Array<{url:string,title:string,items:Array,addedAt:number}>}
 */
function loadRecents() {
  try { return JSON.parse(localStorage.getItem(STORAGE_RECENTS) || '[]'); }
  catch { return []; }
}

/**
 * Saves or updates a list in recents (most-recent first, capped).
 *
 * @param {{url:string,title:string,items:Array}} entry
 * @returns {void}
 */
function saveRecent(entry) {
  if (!entry.items || !entry.items.length) return;
  let recents = loadRecents().filter((r) => r.url !== entry.url);
  recents.unshift({ ...entry, addedAt: Date.now() });
  recents = recents.slice(0, MAX_RECENTS);
  localStorage.setItem(STORAGE_RECENTS, JSON.stringify(recents));
  renderRecents();
}

/**
 * Removes a recent by URL.
 *
 * @param {string} url
 * @returns {void}
 */
function removeRecent(url) {
  const recents = loadRecents().filter((r) => r.url !== url);
  localStorage.setItem(STORAGE_RECENTS, JSON.stringify(recents));
  renderRecents();
}

/**
 * Renders the recents chips under the URL input.
 *
 * @returns {void}
 */
function renderRecents() {
  const recents = loadRecents();
  if (!recents.length) {
    recentsEl.classList.add('hidden');
    recentsEl.innerHTML = '';
    return;
  }
  recentsEl.innerHTML = `
    <div class="recent-label">Recent</div>
    <div class="chips">
      ${recents.map((r) => `
        <button class="chip" data-url="${escapeHtml(r.url)}" title="${escapeHtml(r.url)}">
          <span>${escapeHtml(r.title || 'Lijst')} <small>(${r.items.length})</small></span>
          <span class="x" data-remove="${escapeHtml(r.url)}" title="Verwijder">×</span>
        </button>`).join('')}
    </div>`;
  recentsEl.classList.remove('hidden');
  recentsEl.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const removeUrl = e.target.dataset && e.target.dataset.remove;
      if (removeUrl) {
        e.stopPropagation();
        removeRecent(removeUrl);
        return;
      }
      restoreRecent(btn.dataset.url);
    });
  });
}

/**
 * Restores a previously loaded list from localStorage without hitting the proxy.
 *
 * @param {string} url
 * @returns {void}
 */
function restoreRecent(url) {
  const entry = loadRecents().find((r) => r.url === url);
  if (!entry) return;
  urlInput.value = entry.url;
  state.places = entry.items;
  state.title = entry.title || 'Lijst';
  listTitle.textContent = `${state.title} (${state.places.length} plekken)`;
  renderPlaceList();
  drawUnordered();
  fitMap();
  stepOptions.classList.remove('hidden');
  stepResult.classList.add('hidden');
  state.ordered = [];
  localStorage.setItem(STORAGE_URL, url);
  setMsg(loadMsg, `Hersteld uit recents: ${state.places.length} plekken.`, 'ok');
}
