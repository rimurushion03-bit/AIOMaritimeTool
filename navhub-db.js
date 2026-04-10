/**
 * navhub-db.js
 * Shared IndexedDB helper untuk NavHub Maritime Navigation Suite
 * Include di semua halaman: <script src="../navhub-db.js"></script>
 * Atau di modul iframe:     <script src="../../navhub-db.js"></script>
 */

const NavHubDB = (() => {

  const DB_NAME    = 'navhub-db';
  const DB_VERSION = 1;

  // ── Store names ──
  const STORES = {
    CHART_DATA : 'chart-data',   // JSON index peta navigasi
    GPX_FILES  : 'gpx-files',    // File GPX (route / waypoints)
    ROUTES     : 'routes',       // Generated routes dari chart planner
    SETTINGS   : 'settings',     // App preferences
  };

  // ── Open / Init DB ──
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const db = e.target.result;
        Object.values(STORES).forEach(name => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        });
      };

      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Generic CRUD ──
  async function put(storeName, record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function get(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async function remove(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => reject(req.error);
    });
  }

  async function clear(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve(true);
      req.onerror   = () => reject(req.error);
    });
  }

  // ════════════════════════════════════════
  //  HIGH-LEVEL API
  // ════════════════════════════════════════

  // ── CHART DATA ──
  async function saveChartData(jsonText) {
    const json  = JSON.parse(jsonText);
    const layers = json.layers || json;
    let total = 0;
    const layerCounts = {};
    for (const [ln, recs] of Object.entries(layers)) {
      const key   = ln.toUpperCase();
      const count = Array.isArray(recs) ? recs.length : 0;
      layerCounts[key] = (layerCounts[key] || 0) + count;
      total += count;
    }
    await put(STORES.CHART_DATA, {
      id         : 'main',
      raw        : jsonText,
      totalCharts: total,
      layerCounts,
      sizeKB     : Math.round(jsonText.length / 1024),
      savedAt    : new Date().toISOString(),
    });
    return { total, layerCounts };
  }

  async function getChartData() {
    return get(STORES.CHART_DATA, 'main');
  }

  async function deleteChartData() {
    return remove(STORES.CHART_DATA, 'main');
  }

  // ── GPX FILES ──
  async function saveGPX(id = 'main', payload) {
    // payload: { fileName, waypoints[], trackPoints[], rawGPX? }
    await put(STORES.GPX_FILES, {
      id,
      fileName       : payload.fileName || 'route.gpx',
      waypoints      : payload.waypoints      || [],
      trackPoints    : payload.trackPoints    || [],
      rawGPX         : payload.rawGPX         || null,
      waypointCount  : (payload.waypoints  || []).length,
      trackPointCount: (payload.trackPoints|| []).length,
      savedAt        : new Date().toISOString(),
    });
  }

  async function getGPX(id = 'main') {
    return get(STORES.GPX_FILES, id);
  }

  async function getAllGPX() {
    return getAll(STORES.GPX_FILES);
  }

  async function deleteGPX(id = 'main') {
    return remove(STORES.GPX_FILES, id);
  }


  // Parse raw GPX string - support wpt (NavHub), rtept (Navionic), trkpt (track)
  function parseGPXString(gpxText) {
    const parser = new DOMParser();
    const xml    = parser.parseFromString(gpxText, 'text/xml');

    // Helper: ambil nama, support <name> dan <n>
    const getName = (el, i) =>
      el.querySelector('name')?.textContent ||
      el.querySelector('n')?.textContent    ||
      ('WP' + (i + 1));

    // Priority: wpt -> rtept (Navionic route points)
    let wptEls = [...xml.querySelectorAll('wpt')];
    if (!wptEls.length) wptEls = [...xml.querySelectorAll('rtept')];

    const wpts = wptEls.map((w, i) => ({
      lat : parseFloat(w.getAttribute('lat')),
      lon : parseFloat(w.getAttribute('lon')),
      name: getName(w, i),
    })).filter(w => !isNaN(w.lat) && !isNaN(w.lon));

    // trackPoints: trkpt, fallback ke rtept kalau tidak ada trk
    let trkEls = [...xml.querySelectorAll('trkpt')];
    if (!trkEls.length) trkEls = [...xml.querySelectorAll('rtept')];

    const trkpts = trkEls.map(p => ({
      lat: parseFloat(p.getAttribute('lat')),
      lon: parseFloat(p.getAttribute('lon')),
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

    return { waypoints: wpts, trackPoints: trkpts };
  }

  // Generate GPX - format kompatibel Navionic (wpt + rte/rtept + trk)
  function generateGPXString(waypoints, trackName = 'NavHub Route') {
    const dt = new Date().toISOString();
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpx += `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="NavHub">\n`;
    gpx += `<metadata><n>${trackName}</n><time>${dt}</time></metadata>\n`;

    // <wpt> - kompatibilitas umum
    waypoints.forEach(wp => {
      gpx += `<wpt lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">`;
      gpx += `<n>${wp.name || ''}</n>`;
      gpx += `</wpt>\n`;
    });

    // <rte> - format Navionic, dibaca Navionics Boating App
    gpx += `<rte><n>${trackName}</n>\n`;
    waypoints.forEach(wp => {
      gpx += `<rtept lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">`;
      gpx += `<n>${wp.name || ''}</n>`;
      gpx += `</rtept>\n`;
    });
    gpx += `</rte>\n`;

    // <trk> - kompatibilitas track recorder / apps lain
    gpx += `<trk><n>${trackName}</n><trkseg>\n`;
    waypoints.forEach(wp => {
      gpx += `<trkpt lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}"/>\n`;
    });
    gpx += `</trkseg></trk>\n</gpx>`;

    return gpx;
  }

  // ── ROUTES ──
  async function saveRoute(route) {
    // route: { id, name, chain[], waypoints[], date }
    const id = route.id || Date.now();
    await put(STORES.ROUTES, { ...route, id, savedAt: new Date().toISOString() });
    return id;
  }

  async function getRoute(id) {
    return get(STORES.ROUTES, id);
  }

  async function getAllRoutes() {
    return getAll(STORES.ROUTES);
  }

  async function deleteRoute(id) {
    return remove(STORES.ROUTES, id);
  }

  // ── SETTINGS ──
  async function saveSetting(key, value) {
    await put(STORES.SETTINGS, { id: key, value });
  }

  async function getSetting(key, defaultValue = null) {
    const rec = await get(STORES.SETTINGS, key);
    return rec ? rec.value : defaultValue;
  }

  // ── DB SIZE ESTIMATE ──
  async function getDBSize() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        return {
          usedMB : (est.usage  / 1024 / 1024).toFixed(1),
          quotaMB: (est.quota  / 1024 / 1024).toFixed(0),
          pct    : ((est.usage / est.quota) * 100).toFixed(1),
        };
      }
    } catch(e) {}
    return { usedMB:'?', quotaMB:'?', pct:'?' };
  }

  // ── postMessage helper (child → parent notify) ──
  function notifyParent(type, payload = {}) {
    try {
      window.parent.postMessage({ type, ...payload }, '*');
    } catch(e) {}
  }

  // ── Public API ──
  return {
    STORES,
    // Chart
    saveChartData, getChartData, deleteChartData,
    // GPX
    saveGPX, getGPX, getAllGPX, deleteGPX,
    parseGPXString, generateGPXString,
    // Routes
    saveRoute, getRoute, getAllRoutes, deleteRoute,
    // Settings
    saveSetting, getSetting,
    // Utils
    getDBSize, notifyParent,
    // Low-level
    openDB, put, get, getAll, remove, clear,
  };

})();
