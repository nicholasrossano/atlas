// Atlas/public/js/app.js

// ─────────── Section Header ───────────
console.log("[atlas] app.js v16 booting");

// ─────────── Section Header ───────────
const atlasConfig = window.ATLAS_CONFIG || {};
const maptilerConfig = atlasConfig.maptiler || {};

// ─────────── Section Header ───────────
const MAPTILER_KEY = maptilerConfig.apiKey || "";
const STYLE_ID     = maptilerConfig.styleId || "";
const API_ROOT     = maptilerConfig.apiRoot || "https://api.maptiler.com";
const STYLE_URL    = MAPTILER_KEY && STYLE_ID
	? `${API_ROOT}/maps/${STYLE_ID}/style.json?key=${MAPTILER_KEY}`
	: "";
const FALLBACK_STYLE = {
	version: 8,
	sources: {},
	layers: [
		{
			id: "background",
			type: "background",
			paint: { "background-color": "#f6f2ec" }
		}
	]
};

const SOURCE_ID    = "countries";
const SOURCE_LAYER = "administrative";

const HIGHLIGHT_COLOR = "#301900";
const BLUSH_COLOR = "#ECE4DB";
const BORDER_COLOR = "#FEFCF6";

const MIN_ZOOM = 1.5, MAX_ZOOM = 5, INITIAL_CENTER = [0,0], INITIAL_ZOOM = 1.5;
const MIN_LAT = -60, MAX_LAT = 85;
const ZOOM_LABEL_SWITCH = 2.0;

const SELECT_ZOOM = 2.5;
const SELECT_DURATION_MS = 900;
const SELECTION_FADE_MS = 260;
const AVAIL_OPACITY = 0.95;
const FADE_OPACITY = 0.85;
const HIGHLIGHT_OPACITY = 0.95;
const layerFadeTransition = () => ({ duration: SELECTION_FADE_MS, delay: 0 });

const show = (msg, ...rest) => console.log(`[map] ${msg}`, ...rest);

if (!MAPTILER_KEY || !STYLE_ID) {
	console.warn("[atlas] Missing MapTiler config: set window.ATLAS_CONFIG.maptiler in /config.js");
}

// ─────────── Section Header ───────────
function ensureKey(url){ return url.includes("key=") ? url : `${url}${url.includes("?") ? "&" : "?"}key=${MAPTILER_KEY}`; }
maplibregl.addProtocol("maptiler", async (params, abortController) => {
	const url = ensureKey(params.url.replace("maptiler://", `${API_ROOT}/`));
	const res = await fetch(url, { signal: abortController.signal });
	if (!res.ok) { show(`Fetch fail ${res.status} ${url}`); throw new Error(`HTTP ${res.status}`); }
	const ct = res.headers.get("content-type") || "";
	const data = (ct.includes("application/json") || ct.startsWith("text/")) ? await res.text() : await res.arrayBuffer();
	return { data,
		cacheControl: res.headers.get("cache-control") || undefined,
		expires:      res.headers.get("expires") || undefined,
		modified:     res.headers.get("last-modified") || undefined,
		etag:         res.headers.get("etag") || undefined
	};
});

// ─────────── Section Header ───────────
const map = new maplibregl.Map({
	container: "map",
	style: STYLE_URL || FALLBACK_STYLE,
	center: INITIAL_CENTER,
	zoom: INITIAL_ZOOM,
	minZoom: MIN_ZOOM,
	maxZoom: MAX_ZOOM,
	renderWorldCopies: true,
	pitchWithRotate: false,
	dragRotate: false,
	touchPitch: false,
	attributionControl: true,
	transformRequest: (url) => url.startsWith(API_ROOT) ? ({ url: ensureKey(url) }) : ({ url })
});

map.touchZoomRotate.enable(); map.touchZoomRotate.disableRotation();
map.scrollZoom.enable();
map.boxZoom.disable(); map.doubleClickZoom.disable();

function clampLatNow(){
	const c = map.getCenter();
	const clampedLat = Math.max(MIN_LAT, Math.min(MAX_LAT, c.lat));
	if (clampedLat !== c.lat) map.setCenter([c.lng, clampedLat]);
}
map.on("drag", clampLatNow);
map.on("zoom", clampLatNow);

const hardResize = () => { try { map.resize(); } catch(_){} };
["load","resize"].forEach(evt => window.addEventListener(evt, () => requestAnimationFrame(hardResize)));
window.addEventListener("orientationchange", () => setTimeout(hardResize, 0));
window.addEventListener("pageshow", hardResize);
document.addEventListener("visibilitychange", () => requestAnimationFrame(hardResize));

// ─────────── Section Header ───────────
const FADE_LAYER_ID="oly-fade", AVAIL_LAYER_ID="oly-avail", HIGHLIGHT_LAYER_ID="oly-hi", LABEL_LAYER_ID="oly-label", HITBOX_LAYER_ID="oly-hit";
const LABEL_SOURCE_ID="oly-label-src";

const COUNTRY_LEVEL = 0;
const COUNTRY_BASE_FILTER = ["all", ["==", ["get","level"], COUNTRY_LEVEL], ["!=", ["get","iso_a2"], "AQ"]];

let selectedIso = null;
let availHideTimer = null;
let selectionHideTimer = null;
let baseLabelLayerIds=[], borderLineLayerIds=[], continentLabelLayerIds=[], countryLabelLayerIds=[], otherLabelLayerIds=[];

// ─────────── Section Header ───────────
const infoBox   = document.getElementById("atlas-info");
const infoFlag  = document.getElementById("atlas-flag");
const infoName  = document.getElementById("atlas-name");
const booksList = document.getElementById("atlas-books");
const emptyMsg  = document.getElementById("atlas-empty");
const searchInner = document.querySelector(".atlas-chat-shell");

// ─────────── Section Header ───────────
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function isoToFlagEmoji(iso2){
	if(!iso2||iso2.length!==2) return "🏳️";
	const base=127397, a=iso2.toUpperCase().charCodeAt(0), b=iso2.toUpperCase().charCodeAt(1);
	if(a<65||a>90||b<65||b>90) return "🏳️";
	return String.fromCodePoint(base+a, base+b);
}
function fullCountryName(iso, propName){
	const cleanIso = (typeof iso === "string") ? iso.trim().toUpperCase() : "";
	try {
		if (cleanIso && cleanIso.length === 2){
			const dn = regionNames.of(cleanIso);
			if (dn && dn.trim()) return dn.trim();
		}
	} catch {}

	if (propName && typeof propName === "string" && propName.trim().length > 2) return propName.trim();
	return cleanIso || propName || "—";
}
function escapeHtml(str){
	return String(str || "").replace(/[&<>"']/g, ch => {
		switch(ch){
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			case "\"": return "&quot;";
			case "'": return "&#39;";
			default: return ch;
		}
	});
}

// ─────────── Section Header ───────────
const STUB_EVERYWHERE = false;
const PLACEHOLDER_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" width="68" height="102"><rect width="100%" height="100%" fill="#eae7df"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui" font-size="10" fill="#888">No Cover</text></svg>`
);

// ─────────── Section Header ───────────
let _db = null;
const BOOKS_COLLECTION = "atlasBooks";
let _allBooksPromise = null;
const _booksByIsoCache = new Map();
let _availableIsoList = [];

async function ensureFirestore(){
	if (_db) return _db;

	if (window.firebase?.apps?.length) {
		_db = window.firebase.firestore();
		console.log("[atlas] Firestore ready (compat)");
		return _db;
	}

	const cfg = (window.FIREBASE_ATLAS_CONFIG && typeof window.FIREBASE_ATLAS_CONFIG === "object") ? window.FIREBASE_ATLAS_CONFIG : null;
	if (!cfg) {
		console.warn("[atlas] Firestore not configured: set window.FIREBASE_ATLAS_CONFIG or load Firebase before app.js");
		return null;
	}

	const load = (src) => new Promise((res, rej) => { const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
	await load("https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js");
	await load("https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore-compat.js");

	if (!window.firebase?.apps?.length) window.firebase.initializeApp(cfg);
	_db = window.firebase.firestore();
	console.log("[atlas] Firestore ready (compat)");
	return _db;
}

// ─────────── Section Header ───────────
function isoCandidates(iso2){
	const ISO = String(iso2 || "").toUpperCase();
	const lower = ISO.toLowerCase();
	let longName = "";
	try { longName = regionNames.of(ISO) || ""; } catch(_) {}
	const arr = [ISO, lower];
	if (longName && longName.length > 2) arr.push(longName);
	return arr;
}

let lastBooksIso = null;
let lastBooksItems = [];
let selectedBook = null;

function normalizeCountryToken(value){
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.toUpperCase();
}

function normalizeTokenList(field){
	const tokens = [];
	const seen = new Set();
	const push = (val) => {
		const norm = normalizeCountryToken(val);
		if (!norm || seen.has(norm)) return;
		seen.add(norm);
		tokens.push(norm);
	};
	if (Array.isArray(field)) field.forEach(push);
	else push(field);
	return tokens;
}

function normalizeTagList(field){
	const out = [];
	if (Array.isArray(field)) {
		for (const val of field){
			if (typeof val !== "string") continue;
			const trimmed = val.trim();
			if (trimmed) out.push(trimmed);
		}
	} else if (typeof field === "string") {
		const trimmed = field.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

function hasTokenMatch(tokens, candidates){
	if (!tokens.length || !candidates.length) return false;
	const pool = new Set(tokens);
	for (const cand of candidates) if (pool.has(cand)) return true;
	return false;
}

// ─────────── Section Header ───────────
async function loadAllBooks(db){
	if (_allBooksPromise) return _allBooksPromise;

	_allBooksPromise = (async () => {
		try {
			const snapshot = await db.collection(BOOKS_COLLECTION).get();
			const records = [];
			snapshot.forEach(doc => {
				const data = doc.data() || {};
				const summary = typeof data.summary === "string" ? data.summary : "";
				const bookshopUrl = (typeof data.bookshop_url === "string" && data.bookshop_url.trim())
					? data.bookshop_url
					: (typeof data.bookshop === "string" ? data.bookshop : "");
				records.push({
					id: doc.id,
					title: data.title || "",
					author: data.author || "",
					cover_url: data.cover_url || "",
					summary,
					bookshop_url: bookshopUrl,
					tags: normalizeTagList(data.tags),
					read: data.read === true,
					overrideTokens: normalizeTokenList(data.country_override)
				});
			});
			console.log(`[atlas] cached ${records.length} book(s) from ${BOOKS_COLLECTION}`);
			return records;
		} catch (err) {
			_allBooksPromise = null;
			throw err;
		}
	})();

	return _allBooksPromise;
}

// ─────────── Section Header ───────────
function computeAvailableIsoList(records){
	const out = new Set();
	for (const rec of records){
		for (const t of (rec.overrideTokens || [])){
			if (t && typeof t === "string" && t.length === 2) out.add(t.toUpperCase());
		}
	}
	const arr = Array.from(out).filter(iso => iso !== "AQ").sort();
	return arr;
}

// ─────────── Section Header ───────────
function availabilityPaintExpr(){
	return [
		"case",
		["==", ["get","iso_a2"], "AQ"], "rgba(0,0,0,0)",
		HIGHLIGHT_COLOR
	];
}

function updateAvailabilityStyle(){
	if (!map.getLayer(AVAIL_LAYER_ID)) return;
	try {
		map.setPaintProperty(AVAIL_LAYER_ID, "fill-color", availabilityPaintExpr());
	} catch(_) {}
}

// ─────────── Section Header ───────────
async function fetchBooksByCountry(iso2){
	const candidates = isoCandidates(iso2);
	const ISO = candidates[0];
	const db = await ensureFirestore();

	if (!db) {
		if (STUB_EVERYWHERE) {
			return [{ title:"Lie with Me", author:"Philippe Besson", cover_url:"https://books.google.com/books/content?id=rvePDwAAQBAJ&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api" }];
		}
		return [];
	}

	if (!ISO) return [];

	const cached = _booksByIsoCache.get(ISO);
	if (cached) return cached;

	const compute = async () => {
		const normalizedCandidates = Array.from(new Set(candidates.map(normalizeCountryToken).filter(Boolean)));
		if (!normalizedCandidates.length) return [];

		let records = [];
		try {
			records = await loadAllBooks(db);
		} catch (err) {
			console.error("[atlas] Failed to load book cache:", err);
			throw err;
		}

		const items = records.filter(rec => hasTokenMatch(rec.overrideTokens || [], normalizedCandidates));

		items.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||"")));
		console.log("[atlas] fetched", items.length, "book(s) for", ISO, "from cache");
		return items;
	};

	const promise = compute().catch(err => {
		_booksByIsoCache.delete(ISO);
		throw err;
	});
	_booksByIsoCache.set(ISO, promise);
	return promise;
}

// ─────────── Section Header ───────────
function renderBooks(items, iso){
	if (!booksList || !emptyMsg) return;

	lastBooksIso = iso;
	lastBooksItems = Array.isArray(items) ? items.slice() : [];
	selectedBook = null;
	if (infoBox) infoBox.classList.remove("is-book-detail");

	if (!Array.isArray(items) || items.length === 0){
		booksList.innerHTML = "";
		booksList.hidden = true;
		emptyMsg.hidden = false;
		console.log("[atlas] empty list for", iso);
		return;
	}

	const html = items.map((it, idx) => {
		const title = String(it.title || "").trim() || "Untitled";
		const author = String(it.author || "").trim() || "Unknown";
		const cover = String(it.cover_url || "").trim() || PLACEHOLDER_COVER;
		const safeAlt = `Cover of '${title}'`;
		return `
   <div class="atlas-book" data-idx="${idx}">
  <img class="atlas-book-cover" src="${cover}" alt="${escapeHtml(safeAlt)}">
  <div class="atlas-book-meta">
 <div class="atlas-book-title">${escapeHtml(title)}</div>
 <div class="atlas-book-author">${escapeHtml(author)}</div>
  </div>
   </div>
 `;
	}).join("");

	booksList.innerHTML = html;
	booksList.hidden = false;
	emptyMsg.hidden = true;

	[...booksList.querySelectorAll(".atlas-book-cover")].forEach(img=>{
		img.addEventListener("error", ()=>{ img.src = PLACEHOLDER_COVER; }, { once: true });
		if (!img.getAttribute("src")) img.src = PLACEHOLDER_COVER;
	});

	console.log("[atlas] rendered", items.length, "book(s) for", iso);
}

function showBookDetail(book, iso){
	if (!booksList || !emptyMsg || !book) return;

	selectedBook = book;
	if (infoBox) infoBox.classList.add("is-book-detail");

	const title = String(book.title || "").trim() || "Untitled";
	const author = String(book.author || "").trim() || "Unknown";
	const cover = String(book.cover_url || "").trim() || PLACEHOLDER_COVER;
	const safeAlt = `Cover of '${title}'`;
	const summary = String(book.summary || "").trim();
	const hasSummary = summary.length > 0;
	const rawBuyUrl = String(book.bookshop_url || "").trim();
	const hasBuy = rawBuyUrl.length > 0;
	const isEditorRead = book.read === true;
	const tagColors = ["#8D1717", "#711248", "#BD6217", "#0E5555", "#8285B6", "#127112", "#5F8415"];
	const tags = Array.isArray(book.tags) ? book.tags : [];

	let buyButtonHtml = "";
	if (hasBuy){
		buyButtonHtml = `<a class="atlas-book-buy" href="${escapeHtml(rawBuyUrl)}" target="_blank" rel="noopener">Buy</a>`;
	}

	let summaryHtml = "";
	if (hasSummary){
		summaryHtml = `
  <div class="atlas-book-detail-description">
  <div class="atlas-book-detail-description-text">${escapeHtml(summary)}</div>
  </div>
  `;
	}

	let editorReadHtml = "";
	if (isEditorRead){
		editorReadHtml = `<div class="atlas-book-editor-read">Editor Read</div>`;
	}

	let tagsHtml = "";
	if (tags.length){
		const pills = tags.slice(0, tagColors.length).map((tag, idx) => {
			const text = String(tag || "").trim();
			if (!text) return "";
			return `<span class="atlas-book-tag" style="--tag-color:${tagColors[idx]};">${escapeHtml(text)}</span>`;
		}).filter(Boolean).join("");
		if (pills) tagsHtml = `<div class="atlas-book-tags">${pills}</div>`;
	}

	const html = `
  <div class="atlas-book-detail">
  <div class="atlas-book-detail-header">
   <div class="atlas-book-detail-toprow">
  <button type="button" class="atlas-book-back" aria-label="Close book">×</button>
   </div>
   <div class="atlas-book-detail-main">
  <img class="atlas-book-detail-cover" src="${cover}" alt="${escapeHtml(safeAlt)}">
  <div class="atlas-book-detail-meta">
  <div class="atlas-book-detail-text">
   ${editorReadHtml}
   <div class="atlas-book-detail-title">${escapeHtml(title)}</div>
   <div class="atlas-book-detail-author">${escapeHtml(author)}</div>
   ${tagsHtml}
  </div>
  ${buyButtonHtml}
  </div>
   </div>
  </div>
  ${summaryHtml}
  </div>
  `;

	booksList.innerHTML = html;
	booksList.hidden = false;
	emptyMsg.hidden = true;

	const coverImg = booksList.querySelector(".atlas-book-detail-cover");
	if (coverImg){
		coverImg.addEventListener("error", ()=>{ coverImg.src = PLACEHOLDER_COVER; }, { once: true });
		if (!coverImg.getAttribute("src")) coverImg.src = PLACEHOLDER_COVER;
	}

	const backButton = booksList.querySelector(".atlas-book-back");
	if (backButton){
		backButton.addEventListener("click", () => {
			if (infoBox) infoBox.classList.remove("is-book-detail");
			renderBooks(lastBooksItems, lastBooksIso);
			requestAnimationFrame(placeInfoChip);
		});
	}

	requestAnimationFrame(placeInfoChip);
}

function handleBookCardClick(event){
	const itemEl = event.target.closest(".atlas-book");
	if (!itemEl) return;
	const idxAttr = itemEl.getAttribute("data-idx");
	if (idxAttr === null) return;
	const idx = Number(idxAttr);
	if (!Number.isFinite(idx)) return;
	const book = lastBooksItems[idx];
	if (!book) return;
	showBookDetail(book, lastBooksIso);
}

if (booksList) {
	booksList.addEventListener("click", handleBookCardClick);
}

// ─────────── Section Header ───────────
function isMobile(){ return window.matchMedia("(max-width: 520px)").matches; }

function rectsOverlap(a,b){
	return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}
function placeInfoChip(){
	if (!infoBox.classList.contains("is-visible")) return;
	if (document.body.classList.contains("atlas-chat-expanded")) return;
	if (infoBox.classList.contains("is-suppressed")) return;

	if (isMobile()) {
		if (searchInner) {
			const sh = Math.ceil(searchInner.getBoundingClientRect().height) || 56;
			infoBox.style.setProperty("--atlas-search-h", `${sh}px`);
		}
		infoBox.classList.add("stacked");
		return;
	}

	if (!searchInner) { infoBox.classList.remove("stacked"); return; }
	const sh = Math.ceil(searchInner.getBoundingClientRect().height) || 56;
	infoBox.style.setProperty("--atlas-search-h", `${sh}px`);

	const infoRect   = infoBox.getBoundingClientRect();
	const searchRect = searchInner.getBoundingClientRect();
	if (rectsOverlap(infoRect, searchRect)) infoBox.classList.add("stacked");
	else infoBox.classList.remove("stacked");
}
function showInfo(iso,name){
	infoFlag.textContent = isoToFlagEmoji(iso);
	infoName.textContent = name || iso || "—";
	if (infoBox) infoBox.classList.remove("is-book-detail");

	if (isMobile()) clearSuggestions();

	booksList.innerHTML = `<div class="atlas-loading">Loading…</div>`;
	booksList.hidden = false;
	emptyMsg.hidden = true;
	infoBox.classList.add("is-visible");
	requestAnimationFrame(placeInfoChip);

	lastBooksIso = iso;
	fetchBooksByCountry(iso)
	.then(items => { if (iso === lastBooksIso) renderBooks(items, iso); })
	.catch(err => { console.error(err); if (iso === lastBooksIso) renderBooks([], iso); });
}
function hideInfo(){
	if (infoBox) infoBox.classList.remove("is-book-detail");
	infoBox.classList.remove("is-visible");
	infoBox.classList.remove("stacked");
	booksList.innerHTML = "";
	booksList.hidden = true;
	emptyMsg.hidden = true;
}

// ─────────── Section Header ───────────
const setVisibility=(ids,vis)=>ids.forEach(id=>{ if(map.getLayer(id)) map.setLayoutProperty(id,"visibility",vis); });
const setLayerOpacity = (id, opacity) => {
	try { if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", opacity); } catch(_) {}
};
const setLayerVisibility = (id, visibility) => {
	try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility); } catch(_) {}
};
const clearTimer = (timerId) => {
	if (timerId) clearTimeout(timerId);
	return null;
};
const applyLabelModeForZoom=()=>{ if(selectedIso) return;
	const showContinents = map.getZoom() < ZOOM_LABEL_SWITCH;

	if (otherLabelLayerIds.length)     setVisibility(otherLabelLayerIds,     "none");
	if (continentLabelLayerIds.length) setVisibility(continentLabelLayerIds, showContinents ? "visible":"none");
	if (countryLabelLayerIds.length)   setVisibility(countryLabelLayerIds,   showContinents ? "none":"visible");
};

// ─────────── Section Header ───────────
function _flattenCoords(arr, out) {
	if (!arr) return;
	if (typeof arr[0] === "number") { out.push(arr); return; }
	for (const a of arr) _flattenCoords(a, out);
}
function bboxOfFeature(feature) {
	const coords = [];
	_flattenCoords(feature?.geometry?.coordinates, coords);
	let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
	for (const [x,y] of coords) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
	return [[minX,minY],[maxX,maxY]];
}
function clampBoundsLat(bounds) {
	const [[w,s],[e,n]] = bounds;
	const s2 = Math.max(MIN_LAT, s);
	const n2 = Math.min(MAX_LAT, n);
	return [[w, s2], [e, n2]];
}
function centerOnFeature(feature) {
	const raw = bboxOfFeature(feature);
	if (!raw) return;
	const clamped = clampBoundsLat(raw);
	map.fitBounds(clamped, {
		padding: { top: 90, right: 90, bottom: 100, left: 90 },
		maxZoom: Math.min(4.5, MAX_ZOOM),
		duration: SELECT_DURATION_MS,
		linear: false
	});
}
function centerOnBounds(bbox) {
	if (!bbox || bbox.length !== 4) return;
	const [[w,s],[e,n]] = [[bbox[0], bbox[1]],[bbox[2], bbox[3]]];
	const clamped = clampBoundsLat([[w,s],[e,n]]);
	map.fitBounds(clamped, {
		padding: { top: 90, right: 90, bottom: 100, left: 90 },
		maxZoom: Math.min(4.5, MAX_ZOOM),
		duration: SELECT_DURATION_MS,
		linear: false
	});
}

// ─────────── Section Header ───────────
const EMPTY_LABEL_FC = { type:"FeatureCollection", features: [] };

function clearSelectedLabel(){
	try {
		const src = map.getSource(LABEL_SOURCE_ID);
		if (src && typeof src.setData === "function") src.setData(EMPTY_LABEL_FC);
	} catch(_) {}
	try { if (map.getLayer(LABEL_LAYER_ID)) map.setLayoutProperty(LABEL_LAYER_ID, "visibility", "none"); } catch(_) {}
}

function clampLat(lat){
	return Math.max(MIN_LAT, Math.min(MAX_LAT, lat));
}

function clampZoom(z){
	return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function normalizeIsoValue(value){
	if (typeof value !== "string") return "";
	return value.trim().toUpperCase();
}

function matchesIsoProps(props, iso){
	if (!props || typeof props !== "object") return false;
	const target = normalizeIsoValue(iso);
	if (!target) return false;
	const keys = ["iso_a2", "iso_3166_1", "iso_3166_1_alpha_2", "iso2", "iso_2", "iso", "country_code"];
	for (const key of keys){
		const val = normalizeIsoValue(props[key]);
		if (val && val === target) return true;
	}
	return false;
}

function labelPointFromLabelLayers(iso){
	const labelLayerIds = countryLabelLayerIds.length ? countryLabelLayerIds : baseLabelLayerIds;
	if (!labelLayerIds.length) return null;
	for (const layerId of labelLayerIds){
		const layer = map.getLayer(layerId);
		if (!layer || !layer.source) continue;
		const sourceLayer = layer["source-layer"];
		let feats = [];
		try {
			feats = map.querySourceFeatures(layer.source, sourceLayer ? { sourceLayer } : {}) || [];
		} catch(_) {
			feats = [];
		}
		for (const feat of feats){
			if (!matchesIsoProps(feat?.properties, iso)) continue;
			const geom = feat?.geometry;
			if (!geom) continue;
			if (geom.type === "Point" && Array.isArray(geom.coordinates)) return geom.coordinates;
			if (geom.type === "MultiPoint" && Array.isArray(geom.coordinates) && geom.coordinates.length) return geom.coordinates[0];
		}
	}
	return null;
}

function labelTextFromProps(props){
	const keys = ["name:en","name_en","name","NAME","ADMIN"];
	for (const key of keys){
		const val = props?.[key];
		if (typeof val === "string" && val.trim()) return val.trim();
	}
	return "";
}

function evalTextField(expr, props){
	if (expr == null) return "";
	if (typeof expr === "string" || typeof expr === "number") return String(expr).trim();
	if (!Array.isArray(expr) || !expr.length) return "";
	const op = expr[0];
	switch (op){
		case "get": {
			const key = expr[1];
			if (typeof key !== "string") return "";
			const val = props?.[key];
			return (val == null) ? "" : String(val).trim();
		}
		case "coalesce": {
			for (let i = 1; i < expr.length; i++){
				const val = evalTextField(expr[i], props);
				if (val) return val;
			}
			return "";
		}
		case "concat": {
			const joined = expr.slice(1).map(part => evalTextField(part, props)).join("");
			return joined.trim();
		}
		case "to-string": {
			const val = evalTextField(expr[1], props);
			return val ? String(val).trim() : "";
		}
		case "format": {
			let out = "";
			for (let i = 1; i < expr.length; i += 2){
				const part = evalTextField(expr[i], props);
				if (part) out += part;
			}
			return out.trim();
		}
		default:
			return "";
	}
}

function labelTextFromLabelLayers(iso){
	const labelLayerIds = countryLabelLayerIds.length ? countryLabelLayerIds : baseLabelLayerIds;
	if (!labelLayerIds.length) return "";
	for (const layerId of labelLayerIds){
		const layer = map.getLayer(layerId);
		if (!layer || !layer.source) continue;
		const sourceLayer = layer["source-layer"];
		let feats = [];
		try {
			feats = map.querySourceFeatures(layer.source, sourceLayer ? { sourceLayer } : {}) || [];
		} catch(_) {
			feats = [];
		}
		for (const feat of feats){
			if (!matchesIsoProps(feat?.properties, iso)) continue;
			const props = feat?.properties || {};
			const textField = layer?.layout?.["text-field"];
			const fromExpr = evalTextField(textField, props);
			if (fromExpr) return fromExpr;
			const fromProps = labelTextFromProps(props);
			if (fromProps) return fromProps;
		}
	}
	return "";
}

function baseLabelLayerForStyle(){
	const ids = countryLabelLayerIds.length ? countryLabelLayerIds : baseLabelLayerIds;
	for (const id of ids){
		if (map.getLayer(id)) return id;
	}
	return null;
}

function syncSelectedLabelStyle(){
	if (!map.getLayer(LABEL_LAYER_ID)) return;
	const baseId = baseLabelLayerForStyle();
	if (!baseId) return;
	const baseLayer = map.getLayer(baseId);
	if (!baseLayer) return;

	const layoutKeys = [
		"text-size","text-font","text-justify","text-anchor","text-padding","text-offset",
		"text-allow-overlap","text-max-width","text-letter-spacing","text-transform",
		"text-rotation-alignment","text-keep-upright","text-pitch-alignment","symbol-placement"
	];
	const paintKeys = ["text-color","text-halo-color","text-halo-width","text-halo-blur","text-opacity"];
	const baseLayout = baseLayer.layout || {};
	const basePaint = baseLayer.paint || {};

	for (const key of layoutKeys){
		if (Object.prototype.hasOwnProperty.call(baseLayout, key)) {
			try { map.setLayoutProperty(LABEL_LAYER_ID, key, baseLayout[key]); } catch(_) {}
		}
	}
	for (const key of paintKeys){
		if (Object.prototype.hasOwnProperty.call(basePaint, key)) {
			try { map.setPaintProperty(LABEL_LAYER_ID, key, basePaint[key]); } catch(_) {}
		}
	}
}

function selectionPointForIso(iso, fallbackFeature){
	const labelLayerPoint = labelPointFromLabelLayers(iso);
	if (labelLayerPoint && labelLayerPoint.length === 2) return labelLayerPoint;

	const fallbackPropsPt = extractLabelPointFromProps(fallbackFeature?.properties || null);
	if (fallbackPropsPt && fallbackPropsPt.length === 2) return fallbackPropsPt;

	const pt = labelPointForIso(iso);
	if (pt && pt.length === 2) return pt;

	const bb = bboxOfFeature(fallbackFeature);
	if (bb){
		const [[w,s],[e,n]] = bb;
		return [(w+e)/2, (s+n)/2];
	}
	return null;
}

function setSelectedLabelPoint(lng, lat, labelText){
	const name = String(labelText || "").trim();
	if (!name) return false;

	const fc = {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				properties: { name },
				geometry: { type: "Point", coordinates: [lng, clampLat(lat)] }
			}
		]
	};

	try {
		const src = map.getSource(LABEL_SOURCE_ID);
		if (src && typeof src.setData === "function") src.setData(fc);
		if (map.getLayer(LABEL_LAYER_ID)) map.setLayoutProperty(LABEL_LAYER_ID, "visibility", "visible");
		return true;
	} catch(_) {}
	return false;
}

function extractLabelPointFromProps(props){
	if (!props || typeof props !== "object") return null;
	const pairs = [
		["label_x","label_y"],
		["label_lon","label_lat"],
		["label_lng","label_lat"],
		["centroid_x","centroid_y"],
		["center_x","center_y"],
		["lon","lat"],
		["lng","lat"],
		["x","y"]
	];
	for (const [kx, ky] of pairs){
		const x = Number(props[kx]);
		const y = Number(props[ky]);
		if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
	}
	return null;
}

function unionBboxForIso(iso){
	const clean = String(iso || "").toUpperCase();
	let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
	let did = false;

	let feats = [];
	try {
		feats = map.querySourceFeatures(SOURCE_ID, { sourceLayer: SOURCE_LAYER }) || [];
	} catch(_) {
		feats = [];
	}

	for (const f of feats){
		const v = String(f?.properties?.iso_a2 || "").toUpperCase();
		if (v !== clean) continue;

		const rawLevel = f?.properties?.level;
		const lvl = (typeof rawLevel === "number") ? rawLevel : Number(rawLevel);
		if (lvl !== COUNTRY_LEVEL) continue;

		const props = f?.properties || {};
		const pt = extractLabelPointFromProps(props);
		if (pt) return { point: pt, bbox: null };

		const bb = bboxOfFeature(f);
		if (!bb) continue;
		const [[w,s],[e,n]] = bb;

		minX = Math.min(minX, w);
		minY = Math.min(minY, s);
		maxX = Math.max(maxX, e);
		maxY = Math.max(maxY, n);
		did = true;
	}

	if (!did) return { point: null, bbox: null };
	return { point: [(minX + maxX) / 2, (minY + maxY) / 2], bbox: [[minX, minY], [maxX, maxY]] };
}

function labelPointForIso(iso){
	const res = unionBboxForIso(iso);
	return res.point;
}

function easeToSelectionPoint(pointLngLat){
	if (!pointLngLat || pointLngLat.length !== 2) return;
	const lng = pointLngLat[0];
	const lat = clampLat(pointLngLat[1]);
	map.easeTo({
		center: [lng, lat],
		zoom: clampZoom(SELECT_ZOOM),
		duration: SELECT_DURATION_MS
	});
}

function updateSelectedLabelAndPoint(iso, name, fallbackFeature){
	const labelText = String(name || "").trim() || fullCountryName(iso, "");

	const pt = selectionPointForIso(iso, fallbackFeature);
	if (pt && pt.length === 2){
		setSelectedLabelPoint(pt[0], pt[1], labelText);
		return pt;
	}
	return null;
}

// ─────────── Section Header ───────────
const resetSelection=()=>{ selectedIso=null; const none=["==",["get","iso_a2"],"__none__"];
	availHideTimer = clearTimer(availHideTimer);
	selectionHideTimer = clearTimer(selectionHideTimer);
	if(map.getLayer(HIGHLIGHT_LAYER_ID)){
		map.setFilter(HIGHLIGHT_LAYER_ID,none);
		setLayerOpacity(HIGHLIGHT_LAYER_ID, 0);
	}
	if(map.getLayer(FADE_LAYER_ID)){
		map.setFilter(FADE_LAYER_ID, COUNTRY_BASE_FILTER);
		setLayerOpacity(FADE_LAYER_ID, 0);
	}
	selectionHideTimer = setTimeout(() => {
		setLayerVisibility(HIGHLIGHT_LAYER_ID, "none");
		setLayerVisibility(FADE_LAYER_ID, "none");
		selectionHideTimer = null;
	}, SELECTION_FADE_MS);
	clearSelectedLabel();
	if(map.getLayer(AVAIL_LAYER_ID)){
		setLayerVisibility(AVAIL_LAYER_ID, "visible");
		setLayerOpacity(AVAIL_LAYER_ID, 0);
		requestAnimationFrame(() => setLayerOpacity(AVAIL_LAYER_ID, AVAIL_OPACITY));
	}
	setVisibility(baseLabelLayerIds,"visible");
	applyLabelModeForZoom();
	hideInfo();
};

function selectIso(iso, name, options){
	if (chatIsExpanded) collapseChat("map_pick", { force: true, preserve: true });
	const opts = (options && typeof options === "object") ? options : {};
	const shouldShowInfo = !(opts.showInfo === false);
	const allowToggle = (opts.allowToggle !== false);
	const pickedFeature = opts.feature || null;

	if(!iso||iso==="AQ"){ resetSelection(); return; }
	if(allowToggle && iso===selectedIso){ resetSelection(); return; }
	selectedIso=iso;

	const highlightFilter=["all",
		["==", ["get","level"], COUNTRY_LEVEL],
		["==",["get","iso_a2"],iso]
	];

	const fadeFilter=["all",
		["==", ["get","level"], COUNTRY_LEVEL],
		["!=",["get","iso_a2"],iso],
		["!=",["get","iso_a2"],"AQ"]
	];

	map.setFilter(HIGHLIGHT_LAYER_ID,highlightFilter);
	map.setFilter(FADE_LAYER_ID,fadeFilter);

	availHideTimer = clearTimer(availHideTimer);
	selectionHideTimer = clearTimer(selectionHideTimer);
	setLayerVisibility(HIGHLIGHT_LAYER_ID, "visible");
	setLayerVisibility(FADE_LAYER_ID, "visible");
	setLayerOpacity(HIGHLIGHT_LAYER_ID, 0);
	setLayerOpacity(FADE_LAYER_ID, 0);
	requestAnimationFrame(() => {
		setLayerOpacity(HIGHLIGHT_LAYER_ID, HIGHLIGHT_OPACITY);
		setLayerOpacity(FADE_LAYER_ID, FADE_OPACITY);
	});

	if(map.getLayer(AVAIL_LAYER_ID)){
		setLayerOpacity(AVAIL_LAYER_ID, 0);
		availHideTimer = setTimeout(() => {
			setLayerVisibility(AVAIL_LAYER_ID,"none");
			availHideTimer = null;
		}, SELECTION_FADE_MS);
	}

	setVisibility(baseLabelLayerIds,"none");
	syncSelectedLabelStyle();
	clearSuggestions();

	const infoName = String(name || "").trim() || fullCountryName(iso, "");
	const baseLabel = labelTextFromLabelLayers(iso) || infoName;
	const labelText = baseLabel ? baseLabel.toUpperCase() : infoName.toUpperCase();
	const pt = updateSelectedLabelAndPoint(iso, labelText, pickedFeature);

	if (pt) {
		easeToSelectionPoint(pt);
	} else {
		const attempt = () => {
			const p2 = updateSelectedLabelAndPoint(iso, labelText, pickedFeature);
			if (p2) easeToSelectionPoint(p2);
			return !!p2;
		};
		try { map.once("idle", () => { attempt(); }); } catch(_) {}
		setTimeout(() => { attempt(); }, 350);
	}

	if (shouldShowInfo) showInfo(iso, infoName);
}

function handlePickAtPoint(point){
	const pad=10; const box=[[point.x-pad,point.y-pad],[point.x+pad,point.y+pad]];
	const hit=map.queryRenderedFeatures(box,{layers:[HITBOX_LAYER_ID]});
	if(hit.length){
		const f   = hit[0];
		const iso = f?.properties?.iso_a2;
		const propName = f?.properties?.name ?? f?.properties?.name_en ?? f?.properties?.NAME ?? f?.properties?.ADMIN;
		const nice = fullCountryName(iso, propName);
		selectIso(iso, nice, { feature: f });
		requestAnimationFrame(placeInfoChip);
	} else {
		resetSelection();
	}
}

// ─────────── Section Header ───────────
map.on("load",()=>{ show("Map load OK"); hardResize();
	if(!map.getSource(SOURCE_ID)){ show(`Missing source '${SOURCE_ID}'`); return; }

	map.getStyle().layers.forEach(layer=>{
		if(!layer?.id || layer.id.startsWith("oly-")) return;

		if (layer.source === SOURCE_ID){
			try { map.setLayoutProperty(layer.id, "visibility", "none"); } catch(_) {}
			return;
		}

		if(layer.type==="symbol"){
			baseLabelLayerIds.push(layer.id);
			const s=(layer["source-layer"]||"").toLowerCase(), id=(layer.id||"").toLowerCase();
			if(s.includes("continent")||id.includes("continent")) continentLabelLayerIds.push(layer.id);
			else if(s.includes("country")||id.includes("country")) countryLabelLayerIds.push(layer.id);
			else otherLabelLayerIds.push(layer.id);
		}
		if(layer.type==="line" && typeof layer["source-layer"]==="string" &&
		   layer["source-layer"].toLowerCase().startsWith("boundary")){
			borderLineLayerIds.push(layer.id);
		}
	});

	if (borderLineLayerIds.length) setVisibility(borderLineLayerIds, "none");

	const beforeLabels = baseLabelLayerIds.length ? baseLabelLayerIds[0] : undefined;

	map.addLayer({ id:AVAIL_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{
			"fill-color": availabilityPaintExpr(),
			"fill-opacity": AVAIL_OPACITY,
			"fill-outline-color": BORDER_COLOR,
			"fill-color-transition": layerFadeTransition(),
			"fill-opacity-transition": layerFadeTransition(),
			"fill-outline-color-transition": layerFadeTransition()
		},
		layout:{ visibility:"visible" },
		filter: COUNTRY_BASE_FILTER
	}, beforeLabels);

	map.addLayer({ id:FADE_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{
			"fill-color": BLUSH_COLOR,
			"fill-opacity": FADE_OPACITY,
			"fill-outline-color": BORDER_COLOR,
			"fill-color-transition": layerFadeTransition(),
			"fill-opacity-transition": layerFadeTransition(),
			"fill-outline-color-transition": layerFadeTransition()
		},
		layout:{ visibility:"none" },
		filter: COUNTRY_BASE_FILTER
	});

	map.addLayer({ id:HIGHLIGHT_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{
			"fill-color":HIGHLIGHT_COLOR,
			"fill-opacity": HIGHLIGHT_OPACITY,
			"fill-outline-color": BORDER_COLOR,
			"fill-color-transition": layerFadeTransition(),
			"fill-opacity-transition": layerFadeTransition(),
			"fill-outline-color-transition": layerFadeTransition()
		},
		layout:{ visibility:"none" },
		filter:["==",["get","iso_a2"],"__none__"]
	});

	if (!map.getSource(LABEL_SOURCE_ID)){
		map.addSource(LABEL_SOURCE_ID, { type:"geojson", data: EMPTY_LABEL_FC });
	}
	map.addLayer({ id:LABEL_LAYER_ID, type:"symbol",
		source: LABEL_SOURCE_ID,
		layout:{
			visibility:"none",
			"text-field":["get","name"],
			"text-size":14,
			"text-justify":"center",
			"text-anchor":"center",
			"text-font":["Open Sans Semibold","Arial Unicode MS Bold"],
			"text-allow-overlap": false,
			"text-padding": 2
		},
		paint:{ "text-color":"#fff", "text-halo-color":HIGHLIGHT_COLOR, "text-halo-width":1 }
	});
	syncSelectedLabelStyle();

	map.addLayer({ id:HITBOX_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{ "fill-opacity":0 },
		filter: COUNTRY_BASE_FILTER
	});

	let recentTouch=false;
	map.on("click",(e)=>{ if(recentTouch){ recentTouch=false; return; } handlePickAtPoint(e.point); });
	let touchStartPoint=null, touchMoved=false;
	map.on("touchstart",(e)=>{ if(e.points && e.points.length===1){ touchStartPoint=e.point; touchMoved=false; } else touchStartPoint=null; });
	map.on("touchmove",(e)=>{ if(!touchStartPoint) return; const dx=e.point.x-touchStartPoint.x, dy=e.point.y-touchStartPoint.y; if((dx*dx+dy*dy)>(10*10)) touchMoved=true; });
	map.on("touchend",()=>{ if(!touchStartPoint||touchMoved){ touchStartPoint=null; return; } handlePickAtPoint(touchStartPoint); touchStartPoint=null; recentTouch=true; setTimeout(()=>recentTouch=false,250); });

	applyLabelModeForZoom();
	map.on("zoom", applyLabelModeForZoom);
	window.addEventListener("resize", ()=>requestAnimationFrame(placeInfoChip));
	window.addEventListener("orientationchange", ()=>setTimeout(placeInfoChip,0));

	(async function prewarmBooksCache(){
		try {
			const db = await ensureFirestore(); if (!db) return;
			const records = await loadAllBooks(db);
			_availableIsoList = computeAvailableIsoList(records);
			updateAvailabilityStyle();
			console.log("[atlas] availability countries:", _availableIsoList.length);
		} catch(e){
			console.warn("[atlas] prewarm failed", e);
		}
	})();
});

// ─────────── Section Header ───────────
const chatThread = document.getElementById("atlas-chat-thread");
const chatInput = document.getElementById("atlas-chat-input");
const chatSendButton = document.getElementById("atlas-chat-send");
const chatClearButton = document.getElementById("atlas-chat-clear");

const chatRoot = document.getElementById("atlas-chat");
const chatInputRow = chatInput ? chatInput.closest(".atlas-chat-input-row") : null;

let chatIsExpanded = false;
let chatIntroInjected = false;
let chatHasUserMessage = false;

function expandChat(trigger){
	if (!chatRoot) return;
	if (!chatIsExpanded){
		chatRoot.classList.remove("is-collapsed");
		chatRoot.classList.add("is-expanded");
		chatIsExpanded = true;
		document.body.classList.add("atlas-chat-expanded");
		requestAnimationFrame(placeInfoChip);
	}
	ensureIntroIfNeeded(trigger);
}

function collapseChat(trigger, options){
	if (!chatRoot) return;
	const opts = (options && typeof options === "object") ? options : {};
	const force = !!opts.force;
	const preserve = !!opts.preserve;
	if (!force){
		if (chatHasUserMessage) return;
		const txt = (chatInput && typeof chatInput.value === "string") ? chatInput.value.trim() : "";
		if (txt.length > 0) return;
	}

	chatRoot.classList.add("is-collapsed");
	chatRoot.classList.remove("is-expanded");
	chatIsExpanded = false;
	document.body.classList.remove("atlas-chat-expanded");
	if (!preserve){
		chatIntroInjected = false;
		chatHasUserMessage = false;
		if (chatThread) chatThread.innerHTML = "";
		chatMessages = [];
	}
	if (chatInput){
		chatInput.blur();
		chatInput.style.height = "40px";
	}
	requestAnimationFrame(placeInfoChip);
}

function ensureIntroIfNeeded(trigger){
	if (!chatIsExpanded) return;
	if (chatIntroInjected) return;
	if (chatHasUserMessage) return;
	if (chatMessages.length > 0) return;

	addChatMessage("assistant", "Tell me what kind of story you're looking for, from themes to setting or anything else. I'll find the best fit from our library", {
		recommendations: [],
		followUpQuestions: [],
		actions: []
	});
	chatIntroInjected = true;
	setChatBusy(false);
}

const ATLAS_CHAT_ENDPOINT = (typeof window.ATLAS_CHAT_ENDPOINT === "string" && window.ATLAS_CHAT_ENDPOINT.trim().length > 0)
	? window.ATLAS_CHAT_ENDPOINT.trim()
	: "https://us-central1-ponder-f84ce.cloudfunctions.net/atlasChat";
const ATLAS_CHAT_DEBUG = window.ATLAS_CHAT_DEBUG === true;

const chatSessionId = (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`);

let chatIsSending = false;
let chatMessages = [];

function clearSuggestions(){}

function setChatBusy(isBusy){
	chatIsSending = isBusy;
	if (chatInput) chatInput.disabled = isBusy;
	if (chatSendButton) chatSendButton.disabled = isBusy;
	if (chatClearButton) chatClearButton.disabled = isBusy || !chatHasUserMessage;
}

function autoResizeChatInput(){
	if (!chatInput) return;
	const minHeight = 40;
	const maxHeight = 140;
	if (!chatIsExpanded){
		chatInput.style.height = `${minHeight}px`;
		return;
	}
	chatInput.style.height = "auto";
	const clamped = Math.min(maxHeight, Math.max(minHeight, chatInput.scrollHeight));
	chatInput.style.height = `${clamped}px`;
	requestAnimationFrame(placeInfoChip);
}

function scrollChatToBottom(){
	if (!chatThread) return;
	chatThread.scrollTop = chatThread.scrollHeight;
}

function safeLink(url){
	try {
		const parsed = new URL(url, window.location.origin);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
		return null;
	} catch {
		return null;
	}
}

function formatInlineMarkdown(text){
	let out = text;
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, rawUrl) => {
		const href = safeLink(rawUrl);
		if (!href) return label;
		return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`;
	});
	out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	return out;
}

function renderMarkdownLines(markdownChunk){
	const escaped = escapeHtml(markdownChunk || "");
	const lines = escaped.split("\n");
	let html = "";
	let inUnordered = false;
	let inOrdered = false;

	const closeLists = () => {
		if (inUnordered){ html += "</ul>"; inUnordered = false; }
		if (inOrdered){ html += "</ol>"; inOrdered = false; }
	};

	for (const rawLine of lines){
		const line = rawLine.replace(/\s+$/g, "");
		if (line.trim().length === 0){
			closeLists();
			html += `<div class="atlas-chat-spacer"></div>`;
			continue;
		}

		const unorderedMatch = line.match(/^\s*[-*]\s+(.*)$/);
		if (unorderedMatch){
			if (!inUnordered){ closeLists(); html += "<ul>"; inUnordered = true; }
			html += `<li>${formatInlineMarkdown(unorderedMatch[1])}</li>`;
			continue;
		}

		const orderedMatch = line.match(/^\s*(\d+)[\.)]\s+(.*)$/);
		if (orderedMatch){
			if (!inOrdered){ closeLists(); html += "<ol>"; inOrdered = true; }
			html += `<li>${formatInlineMarkdown(orderedMatch[2])}</li>`;
			continue;
		}

		closeLists();
		html += `<div class="atlas-chat-line">${formatInlineMarkdown(line)}</div>`;
	}

	closeLists();
	return html;
}

function renderMarkdownToHtml(markdown){
	const raw = String(markdown || "");
	const parts = raw.split("```");
	let html = "";
	for (let i = 0; i < parts.length; i++){
		if (i % 2 === 1){
			const code = escapeHtml(parts[i]);
			html += `<pre><code>${code}</code></pre>`;
		} else {
			html += renderMarkdownLines(parts[i]);
		}
	}
	return html;
}

function buildTypingIndicator(){
	const wrap = document.createElement("div");
	wrap.className = "atlas-chat-typing";
	wrap.innerHTML = "<span></span><span></span><span></span>";
	return wrap;
}

function createChatRowElement(message){
	const row = document.createElement("div");
	row.className = `atlas-chat-row ${message.role}`;

	if (message.role === "user"){
		const bubble = document.createElement("div");
		bubble.className = "atlas-chat-bubble user";
		bubble.textContent = message.text;
		row.appendChild(bubble);
	} else {
		const assistantContent = document.createElement("div");
		assistantContent.className = "atlas-chat-assistant";

		if (message.isLoading){
			assistantContent.appendChild(buildTypingIndicator());
		} else {
			assistantContent.innerHTML = renderMarkdownToHtml(message.markdown);
		}

		if (message.role === "assistant"){
			if (Array.isArray(message.recommendations) && message.recommendations.length){
				const recWrap = document.createElement("div");
				recWrap.className = "atlas-chat-recs";
				assistantContent.appendChild(recWrap);
				renderRecommendationCards(recWrap, message.recommendations);
			}
		}

		row.appendChild(assistantContent);
	}

	message.element = row;
	return row;
}

function addChatMessage(role, text, payload){
	const msg = {
		id: (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`),
		role,
		text: role === "user" ? String(text || "") : "",
		markdown: role === "assistant" ? String(text || "") : "",
		isLoading: !!(payload && payload.isLoading),
		recommendations: payload && Array.isArray(payload.recommendations) ? payload.recommendations : [],
		followUpQuestions: payload && Array.isArray(payload.followUpQuestions) ? payload.followUpQuestions : [],
		actions: payload && Array.isArray(payload.actions) ? payload.actions : [],
		element: null
	};
	chatMessages.push(msg);
	if (chatThread){
		chatThread.appendChild(createChatRowElement(msg));
		scrollChatToBottom();
		requestAnimationFrame(placeInfoChip);
	}
	return msg;
}

function replaceAssistantMessage(placeholder, assistantMarkdown, payload){
	if (!placeholder) return;
	placeholder.isLoading = false;
	placeholder.markdown = String(assistantMarkdown || "");
	placeholder.recommendations = payload && Array.isArray(payload.recommendations) ? payload.recommendations : [];
	placeholder.followUpQuestions = [];
	placeholder.actions = payload && Array.isArray(payload.actions) ? payload.actions : [];

	if (!placeholder.element) return;
	const content = placeholder.element.querySelector(".atlas-chat-assistant");
	if (!content) return;

	content.classList.remove("is-loading");
	content.innerHTML = renderMarkdownToHtml(placeholder.markdown);

	if (placeholder.recommendations.length){
		const recWrap = document.createElement("div");
		recWrap.className = "atlas-chat-recs";
		content.appendChild(recWrap);
		renderRecommendationCards(recWrap, placeholder.recommendations);
	}

	scrollChatToBottom();
	requestAnimationFrame(placeInfoChip);
}

let _booksByIdMapPromise = null;

async function ensureBooksByIdMap(){
	if (_booksByIdMapPromise) return _booksByIdMapPromise;
	_booksByIdMapPromise = (async () => {
		const db = await ensureFirestore();
		if (!db) return new Map();
		const records = await loadAllBooks(db);
		const byId = new Map();
		for (const r of records) byId.set(r.id, r);
		return byId;
	})();
	return _booksByIdMapPromise;
}

function primaryIsoForBook(book){
	const arr = book?.overrideTokens;
	if (!Array.isArray(arr)) return null;
	for (const item of arr){
		if (typeof item === "string" && item.length === 2) return item.toUpperCase();
	}
	return null;
}

function featureForIso(iso){
	if (!iso || !map) return null;
	const clean = String(iso || "").toUpperCase();

	try {
		if (map.loaded && map.loaded()) {
			const feats = map.querySourceFeatures(SOURCE_ID, { sourceLayer: SOURCE_LAYER }) || [];
			for (const f of feats){
				const v = String(f?.properties?.iso_a2 || "").toUpperCase();
				const rawLevel = f?.properties?.level;
				const lvl = (typeof rawLevel === "number") ? rawLevel : Number(rawLevel);
				if (v === clean && lvl === COUNTRY_LEVEL) return f;
			}
		}
	} catch {}

	try {
		const feats2 = map.queryRenderedFeatures(undefined, { layers: [HITBOX_LAYER_ID] }) || [];
		for (const f of feats2){
			const v = String(f?.properties?.iso_a2 || "").toUpperCase();
			const rawLevel = f?.properties?.level;
			const lvl = (typeof rawLevel === "number") ? rawLevel : Number(rawLevel);
			if (v === clean && lvl === COUNTRY_LEVEL) return f;
		}
	} catch {}

	return null;
}

function centerOnIso(iso){
	if (!iso || !map) return;
	const clean = String(iso || "").toUpperCase();

	const attempt = () => {
		const feature = featureForIso(clean);
		if (feature) {
			centerOnFeature(feature);
			return true;
		}
		return false;
	};

	if (attempt()) return;

	try {
		map.once("idle", () => { attempt(); });
	} catch {}

	setTimeout(() => { attempt(); }, 400);
}

async function openBookFromChat(bookId){
	const byId = await ensureBooksByIdMap();
	const book = byId.get(bookId);
	if (!book) return;

	const iso = primaryIsoForBook(book);
	const niceName = iso ? fullCountryName(iso, "") : "Book";

	if (iso){
		selectIso(iso, niceName, { showInfo: false, allowToggle: false });
		centerOnIso(iso);
		lastBooksIso = iso;
		fetchBooksByCountry(iso)
			.then(items => { if (iso === lastBooksIso) lastBooksItems = items; })
			.catch(() => {});
	} else {
		resetSelection();
	}

	infoFlag.textContent = isoToFlagEmoji(iso);
	infoName.textContent = niceName;
	infoBox.classList.add("is-visible");
	showBookDetail(book, iso);
	requestAnimationFrame(placeInfoChip);
}

function focusCountryFromChat(iso){
	if (!iso) return;
	const clean = iso.toUpperCase();
	const nice = fullCountryName(clean, "");
	selectIso(clean, nice, { allowToggle: false });
	centerOnIso(clean);
	requestAnimationFrame(placeInfoChip);
}

function renderRecommendationCards(container, recs){
	if (!container) return;
	container.innerHTML = "";
	const limited = recs.slice(0, 5);
	for (const rec of limited){
		const bookId = String(rec && rec.book_id ? rec.book_id : "");
		const card = document.createElement("button");
		card.type = "button";
		card.className = "atlas-chat-rec";
		card.disabled = true;

		const cover = document.createElement("img");
		cover.className = "atlas-chat-rec-cover";
		cover.alt = "Book cover";
		cover.src = PLACEHOLDER_COVER;

		const meta = document.createElement("div");
		meta.className = "atlas-chat-rec-meta";

		const title = document.createElement("div");
		title.className = "atlas-chat-rec-title";
		title.textContent = "Loading…";

		const author = document.createElement("div");
		author.className = "atlas-chat-rec-author";
		author.textContent = "";

		meta.appendChild(title);
		meta.appendChild(author);

		const arrow = document.createElement("div");
		arrow.className = "atlas-chat-rec-arrow";
		arrow.setAttribute("aria-hidden", "true");
		arrow.innerHTML = `<svg class="atlas-chat-rec-arrow-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm1 5l5 5-5 5v-3H7v-4h6V7z"/></svg>`;

		card.appendChild(cover);
		card.appendChild(meta);
		card.appendChild(arrow);
		container.appendChild(card);

		ensureBooksByIdMap().then(byId => {
			const book = byId.get(bookId);
			if (!book) return;
			const safeTitle = String(book.title || "").trim() || "Untitled";
			const safeAuthor = String(book.author || "").trim() || "Unknown";
			const safeCover = String(book.cover_url || "").trim() || PLACEHOLDER_COVER;

			title.textContent = safeTitle;
			author.textContent = safeAuthor;
			cover.src = safeCover;
			cover.addEventListener("error", () => { cover.src = PLACEHOLDER_COVER; }, { once: true });

			card.disabled = false;
			card.addEventListener("click", () => openBookFromChat(bookId));
		});
	}
}

function buildChatHistoryForApi(){
	const cleaned = chatMessages
		.filter(m => !m.isLoading)
		.slice(-12)
		.map(m => ({
			role: m.role,
			content: m.role === "user" ? m.text : m.markdown
		}));
	return cleaned;
}

async function submitChat(rawText, trigger){
	const text = String(rawText || "").trim();
	if (!text) return;
	if (!chatThread || !chatInput || !chatSendButton) return;
	if (chatIsSending) return;

	addChatMessage("user", text, {});
	chatHasUserMessage = true;
	chatInput.value = "";
	autoResizeChatInput();

	setChatBusy(true);
	const placeholder = addChatMessage("assistant", "", { isLoading: true });

	try {
		const payload = {
			session_id: chatSessionId,
			trigger: String(trigger || "input"),
			context: {
				selected_iso2: selectedIso || null
			},
			messages: buildChatHistoryForApi()
		};
		if (ATLAS_CHAT_DEBUG) payload.debug = true;

		const response = await fetch(ATLAS_CHAT_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});

		if (!response.ok){
			const errorText = await response.text();
			throw new Error(`HTTP ${response.status}: ${errorText}`);
		}

		const data = await response.json();
		const assistantMarkdown = String(data.assistant_markdown || "");
		const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
		const followUps = [];
		const actions = Array.isArray(data.actions) ? data.actions : [];

		replaceAssistantMessage(placeholder, assistantMarkdown, {
			recommendations,
			followUpQuestions: followUps,
			actions
		});

		if (actions && actions.length){
			for (const action of actions){
				if (!action || typeof action.type !== "string") continue;
				if (action.type === "open_book" && typeof action.book_id === "string"){
					openBookFromChat(action.book_id);
					break;
				}
				if (action.type === "focus_country" && typeof action.iso2 === "string"){
					focusCountryFromChat(action.iso2);
					break;
				}
			}
		}
	} catch (err){
		console.error("[atlas chat] error", err);
		replaceAssistantMessage(placeholder, "Sorry — something went wrong talking to the book brain. Try again in a sec.", {
			recommendations: [],
			followUpQuestions: [],
			actions: []
		});
	} finally {
		setChatBusy(false);
	}
}

function setupChat(){
	if (!chatInput || !chatSendButton) return;

	if (chatRoot){
		chatRoot.classList.add("is-collapsed");
		chatRoot.classList.remove("is-expanded");
	}
	document.body.classList.remove("atlas-chat-expanded");

	if (chatInputRow){
		chatInputRow.addEventListener("click", () => expandChat("input_row_click"));
	}
	chatInput.addEventListener("focus", () => expandChat("input_focus"));

	chatSendButton.addEventListener("click", () => {
		expandChat("send_button");
		submitChat(chatInput.value, "send_button");
	});

	chatInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey){
			event.preventDefault();
			expandChat("enter_key");
			submitChat(chatInput.value, "enter_key");
		}
	});

	chatInput.addEventListener("input", () => autoResizeChatInput());
	autoResizeChatInput();

	if (chatClearButton){
		chatClearButton.addEventListener("click", () => {
			if (!chatThread) return;
			chatMessages = [];
			chatThread.innerHTML = "";
			chatIntroInjected = false;
			chatHasUserMessage = false;
			expandChat("clear_button");
			requestAnimationFrame(placeInfoChip);
		});
	}

	document.addEventListener("mousedown", (event) => {
		if (!chatRoot) return;
		if (!chatIsExpanded) return;
		if (chatHasUserMessage) return;
		const target = event.target;
		if (target && chatRoot.contains(target)) return;
		collapseChat("click_away");
	});

	window.addEventListener("resize", ()=>requestAnimationFrame(placeInfoChip));
	window.addEventListener("orientationchange", ()=>setTimeout(placeInfoChip,0));

	setChatBusy(false);
}
setupChat();