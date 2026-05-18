/**
 * Split route page: clusters the loaded places into two balanced groups via
 * 2-means, then optimizes each group's visiting order with OSRM /trip and
 * draws both routes on Leaflet.
 */

const PROXY_HOST = '';

const OSRM_HOSTS = {
  driving: 'https://routing.openstreetmap.de/routed-car',
  cycling: 'https://routing.openstreetmap.de/routed-bike',
  walking: 'https://routing.openstreetmap.de/routed-foot',
};
const GMAPS_TRAVELMODE = { driving: 'driving', cycling: 'bicycling', walking: 'walking' };
const STORAGE_URL = 'route.lastUrl';
const STORAGE_MODE = 'route.mode';
const STORAGE_RECENTS = 'route.recents';
const MAX_RECENTS = 8;
const GROUP_COLORS = ['#2f6fed', '#ff8a3d'];

const state = { places: [], title: '', groups: [] };

const map = L.map('map').setView([52.1, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);
const markersLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

const $ = (id) => document.getElementById(id);
const urlInput = $('list-url');
const btnLoad = $('btn-load');
const loadMsg = $('load-msg');
const stepOptions = $('step-options');
const listTitle = $('list-title');
const placeList = $('place-list');
const optRoundtrip = $('opt-roundtrip');
const optBalance = $('opt-balance');
const btnSplitGo = $('btn-split-go');
const optMsg = $('opt-msg');
const stepResult = $('step-result');
const groupsEl = $('groups');
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
btnSplitGo.addEventListener('click', runSplit);
btnReset.addEventListener('click', reset);

renderRecents();
const presetSplitUrl = new URLSearchParams(location.search).get('list')
  || new URLSearchParams(location.search).get('id');
if (presetSplitUrl) {
  urlInput.value = presetSplitUrl;
  history.replaceState(null, '', location.pathname);
  loadList();
}
initPanelToggle();
initCollapsibles();

/**
 * Wires every .collapsible-toggle and forces collapsed state on mobile.
 *
 * @returns {void}
 */
function initCollapsibles() {
  document.querySelectorAll('.collapsible-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = btn.closest('.collapsible');
      if (!c) return;
      const willCollapse = !c.classList.contains('collapsed');
      c.classList.toggle('collapsed', willCollapse);
      btn.setAttribute('aria-expanded', String(!willCollapse));
    });
  });
  applyCollapsedForViewport();
  window.matchMedia('(max-width: 720px)').addEventListener('change', applyCollapsedForViewport);
}

/**
 * @returns {void}
 */
function applyCollapsedForViewport() {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  document.querySelectorAll('.collapsible').forEach((c) => {
    c.classList.toggle('collapsed', mobile);
    const btn = c.querySelector('.collapsible-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(!mobile));
  });
}

/**
 * Wires up the mobile-only "fullscreen map" toggle.
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
 * Fetches the list via the proxy and prepares the options step.
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
    drawUnorderedMarkers();
    fitMap();
    stepOptions.classList.remove('hidden');
    stepResult.classList.add('hidden');
    state.groups = [];
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
 * Clusters places into two groups and optimizes each one's route.
 *
 * @returns {Promise<void>}
 */
async function runSplit() {
  if (state.places.length < 2) return;
  btnSplitGo.disabled = true;
  setMsg(optMsg, 'Verdelen en optimaliseren...');
  try {
    const mode = getMode();
    localStorage.setItem(STORAGE_MODE, mode);
    const clusters = kMeans2(state.places, optBalance.checked);
    const groups = await Promise.all(clusters.map((c, i) => optimizeGroup(c, mode, optRoundtrip.checked, i)));
    state.groups = groups;
    renderResult();
    stepResult.classList.remove('hidden');
    setMsg(optMsg, 'Klaar.', 'ok');
  } catch (e) {
    setMsg(optMsg, e.message, 'error');
  } finally {
    btnSplitGo.disabled = false;
  }
}

/**
 * Resets the UI back to the empty state.
 *
 * @returns {void}
 */
function reset() {
  state.places = [];
  state.groups = [];
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  stepOptions.classList.add('hidden');
  stepResult.classList.add('hidden');
  setMsg(loadMsg, '');
  map.setView([52.1, 5.3], 7);
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
  const c = document.getElementById('place-count');
  if (c) c.textContent = String(state.places.length);
}

/**
 * Draws unordered (gray) markers on the map.
 *
 * @returns {void}
 */
function drawUnorderedMarkers() {
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  state.places.forEach((p, i) => {
    L.marker([p.lat, p.lng], { icon: numIcon(i + 1, 'unordered', '') })
      .bindPopup(escapeHtml(p.name))
      .addTo(markersLayer);
  });
}

/**
 * Centers the map to fit all visible markers and route lines.
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
 * Partitions places into 2 clusters with k-means seeded by the two farthest-
 * apart points. Optionally rebalances so the cluster sizes differ by at most 1.
 *
 * @param {Array<{lat:number,lng:number}>} places
 * @param {boolean} balanced
 * @returns {Array<Array<{lat:number,lng:number,name:string}>>}
 */
function kMeans2(places, balanced) {
  if (places.length < 2) return [places.slice(), []];
  let bI = 0, bJ = 1, bD = -1;
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const d = haversine([places[i].lat, places[i].lng], [places[j].lat, places[j].lng]);
      if (d > bD) { bD = d; bI = i; bJ = j; }
    }
  }
  let c1 = [places[bI].lat, places[bI].lng];
  let c2 = [places[bJ].lat, places[bJ].lng];
  const assignments = new Array(places.length).fill(-1);

  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const a = haversine([p.lat, p.lng], c1) <= haversine([p.lat, p.lng], c2) ? 0 : 1;
      if (assignments[i] !== a) { assignments[i] = a; changed = true; }
    }
    if (!changed && iter > 0) break;
    [c1, c2] = recomputeCentroids(places, assignments, c1, c2);
  }

  if (balanced) {
    let safety = places.length;
    while (safety-- > 0) {
      const idx1 = [];
      const idx2 = [];
      for (let i = 0; i < places.length; i++) (assignments[i] === 0 ? idx1 : idx2).push(i);
      if (Math.abs(idx1.length - idx2.length) <= 1) break;
      const fromIsOne = idx1.length > idx2.length;
      const fromSet = fromIsOne ? idx1 : idx2;
      const targetCentroid = fromIsOne ? c2 : c1;
      let moveIdx = fromSet[0];
      let bestDist = Infinity;
      for (const i of fromSet) {
        const d = haversine([places[i].lat, places[i].lng], targetCentroid);
        if (d < bestDist) { bestDist = d; moveIdx = i; }
      }
      assignments[moveIdx] = fromIsOne ? 1 : 0;
      [c1, c2] = recomputeCentroids(places, assignments, c1, c2);
    }
  }

  return [
    places.filter((_, i) => assignments[i] === 0),
    places.filter((_, i) => assignments[i] === 1),
  ];
}

/**
 * Recomputes both cluster centroids based on current assignments. Falls back
 * to the previous centroid if a cluster is empty.
 *
 * @param {Array<{lat:number,lng:number}>} places
 * @param {number[]} assignments
 * @param {[number,number]} prev1
 * @param {[number,number]} prev2
 * @returns {[[number,number],[number,number]]}
 */
function recomputeCentroids(places, assignments, prev1, prev2) {
  const g1 = places.filter((_, i) => assignments[i] === 0);
  const g2 = places.filter((_, i) => assignments[i] === 1);
  const c1 = g1.length
    ? [g1.reduce((s, p) => s + p.lat, 0) / g1.length, g1.reduce((s, p) => s + p.lng, 0) / g1.length]
    : prev1;
  const c2 = g2.length
    ? [g2.reduce((s, p) => s + p.lat, 0) / g2.length, g2.reduce((s, p) => s + p.lng, 0) / g2.length]
    : prev2;
  return [c1, c2];
}

/**
 * Runs OSRM /trip on a single cluster and returns the optimized ordering plus
 * geometry. For non-roundtrip the closing leg/geometry is trimmed.
 *
 * @param {Array<{name:string,lat:number,lng:number}>} places
 * @param {string} mode
 * @param {boolean} roundtrip
 * @param {number} groupIdx
 * @returns {Promise<object>}
 */
async function optimizeGroup(places, mode, roundtrip, groupIdx) {
  const color = GROUP_COLORS[groupIdx] || '#777';
  if (places.length < 2) {
    return {
      ordered: places.slice(),
      geometry: places.map((p) => [p.lat, p.lng]),
      distanceKm: 0,
      durationMin: 0,
      color,
      idx: groupIdx,
    };
  }
  const params = new URLSearchParams({ overview: 'full', geometries: 'geojson', roundtrip: 'true' });
  const coordStr = places.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${OSRM_HOSTS[mode]}/trip/v1/driving/${coordStr}?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM trip: ' + (data.message || data.code));
  const trip = data.trips[0];
  const ordered = data.waypoints
    .map((w, originalIndex) => ({ originalIndex, order: w.waypoint_index }))
    .sort((a, b) => a.order - b.order)
    .map((w) => ({ ...places[w.originalIndex] }));
  const legs = trip.legs.slice();
  let geometry = trip.geometry.coordinates.map(([ln, la]) => [la, ln]);
  if (!roundtrip) {
    if (legs.length) legs.pop();
    geometry = dropClosingGeometry(geometry, ordered[0]);
  }
  return {
    ordered,
    geometry,
    distanceKm: legs.reduce((s, l) => s + l.distance, 0) / 1000,
    durationMin: legs.reduce((s, l) => s + l.duration, 0) / 60,
    color,
    idx: groupIdx,
  };
}

/**
 * Trims the part of the geometry that returns to the start point so an open
 * route ends visually at the last visited stop.
 *
 * @param {Array<[number,number]>} geometry
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
 * Draws both groups on the map and renders the sidebar blocks.
 *
 * @returns {void}
 */
function renderResult() {
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  groupsEl.innerHTML = '';

  state.groups.forEach((g, gi) => {
    g.ordered.forEach((stop, i) => {
      L.marker([stop.lat, stop.lng], { icon: numIcon(i + 1, 'group', g.color) })
        .bindPopup(`<strong>Groep ${gi + 1}</strong><br>${escapeHtml(stop.name)}`)
        .addTo(markersLayer);
    });
    if (g.geometry.length > 1) {
      L.polyline(g.geometry, { color: g.color, weight: 5, opacity: 0.85 }).addTo(routeLayer);
    }

    const block = document.createElement('div');
    block.className = 'group-block';
    block.style.borderLeftColor = g.color;
    block.innerHTML = `
      <div class="group-title">
        <span class="group-dot" style="background:${g.color}"></span>
        Groep ${gi + 1} <small>(${g.ordered.length} stops)</small>
      </div>
      <p class="stats"><strong>${g.distanceKm.toFixed(1)} km</strong> · ca. <strong>${formatDuration(g.durationMin)}</strong></p>
      <ol class="places ordered group-list">${g.ordered.map((s, i) =>
        `<li><span class="num" style="background:${g.color}">${i + 1}</span><span><span class="name">${escapeHtml(s.name)}</span></span></li>`,
      ).join('')}</ol>
      ${buildPartsHtml(g)}
    `;
    groupsEl.appendChild(block);
  });

  groupsEl.querySelectorAll('button[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    const url = btn.dataset.url;
    if (action === 'open') {
      btn.addEventListener('click', () => window.open(url, '_blank'));
    } else if (action === 'copy') {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          setMsg(resultMsg, 'Link gekopieerd.', 'ok');
        } catch {
          setMsg(resultMsg, url, 'ok');
        }
      });
    }
  });
  fitMap();
}

/**
 * Returns the parts-list markup for a single group, split into Google-Maps-
 * friendly chunks (max 11 stops per URL).
 *
 * @param {object} group
 * @returns {string}
 */
function buildPartsHtml(group) {
  const stops = group.ordered.slice();
  if (optRoundtrip.checked && stops.length > 0) stops.push(stops[0]);
  if (stops.length < 2) return '';
  const chunks = chunkWithOverlap(stops, 11);
  return `<div class="split-list">${chunks.map((chunk, ci) => {
    const url = buildGoogleMapsUrlForStops(chunk);
    const isSingle = chunks.length === 1;
    const label = isSingle
      ? `Hele route <small>${chunk.length} stops</small>`
      : `Deel ${ci + 1} van ${chunks.length} <small>${chunk.length} stops</small>`;
    return `<div class="row">
      <div class="label">${label}</div>
      <div class="row-actions">
        <button class="primary" data-action="open" data-url="${escapeHtml(url)}">Open in Google Maps</button>
        <button data-action="copy" data-url="${escapeHtml(url)}">Kopieer link</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/**
 * Balanced overlap chunking - same logic as the single-route page.
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
 * Builds a Google Maps directions URL for a concrete ordered stop list.
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
 * @returns {string}
 */
function getMode() {
  const sel = document.querySelector('input[name="mode"]:checked');
  return sel ? sel.value : 'driving';
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {string} [cls]
 * @returns {void}
 */
function setMsg(el, text, cls = '') {
  el.textContent = text;
  el.className = 'hint' + (cls ? ' ' + cls : '');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * @param {number} min
 * @returns {string}
 */
function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}u ${m}m` : `${m}m`;
}

/**
 * Great-circle distance in km between two [lat,lng] points.
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
 * Creates a numbered Leaflet DivIcon, optionally with a custom background.
 *
 * @param {number} n
 * @param {string} role
 * @param {string} color
 * @returns {L.DivIcon}
 */
function numIcon(n, role, color) {
  const styleAttr = color ? ` style="background:${color}"` : '';
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${role}"${styleAttr}>${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/**
 * @returns {Array<{url:string,title:string,items:Array,addedAt:number}>}
 */
function loadRecents() {
  try { return JSON.parse(localStorage.getItem(STORAGE_RECENTS) || '[]'); }
  catch { return []; }
}

/**
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
 * @param {string} url
 * @returns {void}
 */
function removeRecent(url) {
  const recents = loadRecents().filter((r) => r.url !== url);
  localStorage.setItem(STORAGE_RECENTS, JSON.stringify(recents));
  renderRecents();
}

/**
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
  drawUnorderedMarkers();
  fitMap();
  stepOptions.classList.remove('hidden');
  stepResult.classList.add('hidden');
  state.groups = [];
  localStorage.setItem(STORAGE_URL, url);
  setMsg(loadMsg, `Hersteld uit recents: ${state.places.length} plekken.`, 'ok');
}
