// Atlas/public/js/app.js

// ─────────── Section Header ───────────
console.log("[atlas] app.js v43 booting");

// ─────────── Section Header ───────────
const atlasConfig = window.ATLAS_CONFIG || {};
const maptilerConfig = atlasConfig.maptiler || {};
const atlasEndpoints = atlasConfig.atlas || {};

function resolveCatalogEndpoint(){
	if (typeof window.ATLAS_CATALOG_ENDPOINT === "string" && window.ATLAS_CATALOG_ENDPOINT.trim()) {
		return window.ATLAS_CATALOG_ENDPOINT.trim();
	}
	if (typeof atlasEndpoints.catalogEndpoint === "string" && atlasEndpoints.catalogEndpoint.trim()) {
		return atlasEndpoints.catalogEndpoint.trim();
	}
	const chatEndpoint = (typeof window.ATLAS_CHAT_ENDPOINT === "string" && window.ATLAS_CHAT_ENDPOINT.trim())
		? window.ATLAS_CHAT_ENDPOINT.trim()
		: (typeof atlasEndpoints.chatEndpoint === "string" ? atlasEndpoints.chatEndpoint.trim() : "");
	if (chatEndpoint) return chatEndpoint.replace(/\/atlasChat\/?$/i, "/atlasCatalog");
	return "/api/atlas/books";
}

const CATALOG_ENDPOINT = resolveCatalogEndpoint();

// ─────────── Section Header ───────────
const MAPTILER_KEY = maptilerConfig.apiKey || "";
const STYLE_ID     = maptilerConfig.styleId || "";
const API_ROOT     = maptilerConfig.apiRoot || "https://api.maptiler.com";
const STYLE_URL    = MAPTILER_KEY && STYLE_ID
	? `${API_ROOT}/maps/${STYLE_ID}/style.json?key=${MAPTILER_KEY}`
	: "";
const MAP_SURFACE_COLOR = "#FFFEFB";
const FALLBACK_STYLE = {
	version: 8,
	sources: {},
	layers: [
		{
			id: "background",
			type: "background",
			paint: { "background-color": MAP_SURFACE_COLOR }
		}
	]
};

const SOURCE_ID    = "countries";
const SOURCE_LAYER = "administrative";

const HIGHLIGHT_COLOR = "#301900";
const BLUSH_COLOR = "#ECE4DB";
const BORDER_COLOR = "#FFFFFD";

const MIN_ZOOM = 1, MAX_ZOOM = 5, INITIAL_CENTER = [0,0], INITIAL_ZOOM = 1;
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

function applyMapSurfaceColor(){
	map.getStyle().layers.forEach(layer => {
		if (!layer?.id || layer.id.startsWith("oly-")) return;
		if (layer.type === "background") {
			try { map.setPaintProperty(layer.id, "background-color", MAP_SURFACE_COLOR); } catch(_) {}
			return;
		}
		if (layer.type !== "fill") return;
		const sourceLayer = (layer["source-layer"] || "").toLowerCase();
		const id = layer.id.toLowerCase();
		if (sourceLayer === "water" || id.includes("water")) {
			try { map.setPaintProperty(layer.id, "fill-color", MAP_SURFACE_COLOR); } catch(_) {}
		}
	});
}

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
	preserveDrawingBuffer: true,
	pitchWithRotate: false,
	dragRotate: false,
	touchPitch: false,
	attributionControl: false,
	transformRequest: (url) => url.startsWith(API_ROOT) ? ({ url: ensureKey(url) }) : ({ url })
});
window.__atlasMap = map;

map.touchZoomRotate.enable(); map.touchZoomRotate.disableRotation();
map.scrollZoom.enable();
map.boxZoom.disable(); map.doubleClickZoom.disable();

map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.on("error", (e) => show("Map error:", e && e.error ? e.error.message : e));

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
const bookCountEl = document.getElementById("atlas-book-count");
const booksList = document.getElementById("atlas-books");
const emptyMsg  = document.getElementById("atlas-empty");
const chatShell = document.querySelector(".atlas-chat-shell");
const chatBody = document.querySelector(".atlas-chat-body");
const appBanner = document.getElementById("atlas-app-banner");
const appBannerDismiss = document.getElementById("atlas-app-banner-dismiss");
const APP_BANNER_DISMISS_KEY = "atlas-app-banner-dismissed";
const atlasHeader = document.querySelector(".atlas-header");

const MAP_CAMERA_PADDING = { top: 90, right: 90, bottom: 100, left: 90 };

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

// ─────────── Book catalog (server-side Firestore via Cloud Function) ───────────
let _allBooksPromise = null;
const _booksByIsoCache = new Map();

function recordBookFromApi(data){
	const summary = typeof data.summary === "string" ? data.summary : "";
	const description = typeof data.description === "string" ? data.description : "";
	const bookshopUrl = (typeof data.bookshop_url === "string" && data.bookshop_url.trim())
		? data.bookshop_url
		: (typeof data.bookshop === "string" ? data.bookshop : "");
	return {
		id: data.id || "",
		title: data.title || "",
		author: data.author || "",
		cover_url: data.cover_url || "",
		summary,
		description,
		google_books_url: data.google_books_url || "",
		bookshop_url: bookshopUrl,
		tags: normalizeTagList(data.tags),
		read: data.read === true,
		iso2Sets: iso2SetsForRecord(data)
	};
}

async function loadAllBooks(){
	if (_allBooksPromise) return _allBooksPromise;

	_allBooksPromise = (async () => {
		if (!CATALOG_ENDPOINT) throw new Error("Catalog endpoint not configured");

		const res = await fetch(CATALOG_ENDPOINT, {
			method: "GET",
			credentials: "omit",
			headers: { Accept: "application/json" }
		});
		if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);

		const payload = await res.json();
		const rows = Array.isArray(payload?.books) ? payload.books : [];
		const records = rows.map(recordBookFromApi);
		console.log(`[atlas] cached ${records.length} book(s) from catalog API`);
		return records;
	})().catch(err => {
		_allBooksPromise = null;
		throw err;
	});

	return _allBooksPromise;
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

let _countryNameToIso2Cache = null;

function listIso2Codes(){
	if (typeof Intl.supportedValuesOf === "function") {
		return Intl.supportedValuesOf("region").filter(code => typeof code === "string" && code.length === 2);
	}
	const out = [];
	for (let i = 65; i <= 90; i++) {
		for (let j = 65; j <= 90; j++) {
			const code = String.fromCharCode(i) + String.fromCharCode(j);
			try {
				const name = regionNames.of(code);
				if (name && name !== code) out.push(code);
			} catch (_) {}
		}
	}
	return out;
}

function getCountryNameToIso2Map(){
	if (_countryNameToIso2Cache) return _countryNameToIso2Cache;
	const map = new Map();
	for (const code of listIso2Codes()) {
		try {
			const name = regionNames.of(code);
			if (name) map.set(name.trim().toLowerCase(), code.toUpperCase());
		} catch (_) {}
	}
	_countryNameToIso2Cache = map;
	return map;
}

function countryStringToIso2(val){
	if (val == null) return null;
	if (typeof val === "object") return null;
	let raw = "";
	try { raw = String(val).trim(); } catch (_) { return null; }
	if (!raw) return null;

	const t = raw.replace(/_/g, " ").replace(/-/g, " ").trim();
	if (t.length === 2 && /^[a-zA-Z]{2}$/.test(t)) return t.toUpperCase();

	const byName = getCountryNameToIso2Map().get(t.toLowerCase());
	if (byName) return byName;
	return null;
}

function extractIso2Candidates(val){
	const out = [];
	const seen = new Set();
	const add = (x) => {
		const iso2 = countryStringToIso2(x);
		if (!iso2 || seen.has(iso2)) return;
		seen.add(iso2);
		out.push(iso2);
	};

	if (val && typeof val === "object" && !Array.isArray(val)) {
		for (const key of ["iso2", "code", "country", "value", "name"]) {
			if (key in val) add(val[key]);
		}
		for (const v of Object.values(val)) {
			if (typeof v === "string") add(v);
			else if (Array.isArray(v)) v.forEach(add);
		}
	} else if (Array.isArray(val)) {
		val.forEach(add);
	} else if (typeof val === "string") {
		for (const part of val.split(/[,;|/]/)) add(part.trim());
	} else {
		add(val);
	}
	return out;
}

function iso2SetsForRecord(data){
	const override = extractIso2Candidates(data?.country_override);
	const setting = extractIso2Candidates(data?.setting_country);
	const author = [
		...extractIso2Candidates(data?.author_country),
		...extractIso2Candidates(data?.author_origin)
	];
	const anySet = new Set([...override, ...setting, ...author]);
	return { override, setting, author, any: Array.from(anySet) };
}

function hasIso2Match(iso2Sets, candidates){
	const pool = iso2Sets?.any;
	if (!Array.isArray(pool) || !pool.length || !candidates.length) return false;
	const wanted = new Set(candidates);
	for (const iso of pool) if (wanted.has(iso)) return true;
	return false;
}

const HIDDEN_BOOK_TAGS = new Set(["needs review"]);

function isPublicBookTag(tag){
	const text = String(tag || "").trim();
	if (!text) return false;
	return !HIDDEN_BOOK_TAGS.has(text.toLowerCase());
}

function normalizeTagList(field){
	const out = [];
	if (Array.isArray(field)) {
		for (const val of field){
			if (typeof val !== "string") continue;
			const trimmed = val.trim();
			if (trimmed && isPublicBookTag(trimmed)) out.push(trimmed);
		}
	} else if (typeof field === "string") {
		const trimmed = field.trim();
		if (trimmed && isPublicBookTag(trimmed)) out.push(trimmed);
	}
	return out;
}

function buildLoadingSkeleton(){
	return `
<div class="atlas-loading">
  <div class="atlas-loading-row"><div class="atlas-loading-cover"></div><div class="atlas-loading-lines"><div class="atlas-loading-line long"></div><div class="atlas-loading-line short"></div></div></div>
  <div class="atlas-loading-row"><div class="atlas-loading-cover"></div><div class="atlas-loading-lines"><div class="atlas-loading-line long"></div><div class="atlas-loading-line short"></div></div></div>
</div>`;
}

function updateBookCountLabel(count){
	if (!bookCountEl) return;
	if (count == null || !Number.isFinite(count) || count <= 0){
		bookCountEl.hidden = true;
		bookCountEl.textContent = "";
		return;
	}
	const label = count === 1 ? "1 book" : `${count} books`;
	bookCountEl.textContent = `· ${label}`;
	bookCountEl.hidden = false;
}

function renderBookListRow(it, idx){
	const title = String(it.title || "").trim() || "Untitled";
	const author = String(it.author || "").trim() || "Unknown";
	const cover = String(it.cover_url || "").trim() || PLACEHOLDER_COVER;
	const safeAlt = `Cover of '${title}'`;
	return `
   <div class="atlas-book" data-idx="${idx}">
  <img class="atlas-book-cover" src="${cover}" alt="${escapeHtml(safeAlt)}" loading="lazy">
  <div class="atlas-book-meta">
 <div class="atlas-book-title">${escapeHtml(title)}</div>
 <div class="atlas-book-author">${escapeHtml(author)}</div>
  </div>
   </div>
 `;
}

function attachCoverFallbacks(root){
	if (!root) return;
	[...root.querySelectorAll(".atlas-book-cover, .atlas-book-detail-cover, .atlas-chat-rec-cover")].forEach(img=>{
		img.addEventListener("error", ()=>{ img.src = PLACEHOLDER_COVER; }, { once: true });
		if (!img.getAttribute("src")) img.src = PLACEHOLDER_COVER;
	});
}

// ─────────── Section Header ───────────
function countryFillPaintExpr(){
	return [
		"case",
		["==", ["get","iso_a2"], "AQ"], "rgba(0,0,0,0)",
		HIGHLIGHT_COLOR
	];
}

// ─────────── Section Header ───────────
async function fetchBooksByCountry(iso2){
	const candidates = isoCandidates(iso2);
	const ISO = candidates[0];

	if (!CATALOG_ENDPOINT) {
		if (STUB_EVERYWHERE) {
			return [{ title:"Lie with Me", author:"Philippe Besson", cover_url:"https://books.google.com/books/content?id=rvePDwAAQBAJ&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api" }];
		}
		throw new Error("Catalog endpoint not configured");
	}

	if (!ISO) return [];

	const cached = _booksByIsoCache.get(ISO);
	if (cached) return cached;

	const compute = async () => {
		const normalizedCandidates = Array.from(new Set(candidates.map(normalizeCountryToken).filter(Boolean)));
		if (!normalizedCandidates.length) return [];

		let records = [];
		try {
			records = await loadAllBooks();
		} catch (err) {
			console.error("[atlas] Failed to load book cache:", err);
			throw err;
		}

		const items = records.filter(rec => hasIso2Match(rec.iso2Sets, normalizedCandidates));

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

const EMPTY_CATALOG_MSG = `We don't have any books from this country yet. If you have one you'd recommend, please let us know <a href="https://forms.gle/ZwvqKmMmUNZfWrcd8" target="_blank" rel="noopener">here</a>.`;
const EMPTY_LOAD_ERROR_MSG = "Couldn't load books right now. Try again in a moment.";

// ─────────── Section Header ───────────
function renderBooks(items, iso, options = {}){
	if (!booksList || !emptyMsg) return;

	lastBooksIso = iso;
	lastBooksItems = Array.isArray(items) ? items.slice() : [];
	selectedBook = null;
	if (infoBox) infoBox.classList.remove("is-book-detail");

	if (!Array.isArray(items) || items.length === 0){
		booksList.innerHTML = "";
		booksList.hidden = true;
		emptyMsg.innerHTML = options.status === "error" ? EMPTY_LOAD_ERROR_MSG : EMPTY_CATALOG_MSG;
		emptyMsg.hidden = false;
		updateBookCountLabel(0);
		console.log("[atlas] empty list for", iso, options.status || "empty");
		return;
	}

	const html = items.map((it, idx) => renderBookListRow(it, idx)).join("");

	booksList.innerHTML = html;
	booksList.hidden = false;
	emptyMsg.hidden = true;
	updateBookCountLabel(items.length);

	attachCoverFallbacks(booksList);

	console.log("[atlas] rendered", items.length, "book(s) for", iso);
}

const BOOK_TAG_COLORS = ["#8D1717", "#711248", "#BD6217", "#0E5555", "#8285B6", "#127112", "#5F8415"];

function bookGoogleBooksUrl(book){
	const direct = String(book?.google_books_url || book?.info_link || book?.preview_link || "").trim();
	if (direct) return direct;
	const cover = String(book?.cover_url || "");
	const match = cover.match(/[?&]id=([^&]+)/);
	if (match) return `https://books.google.com/books?id=${encodeURIComponent(match[1])}`;
	return "";
}

function getBookDisplayBlurb(book){
	const summary = String(book?.summary || "").trim();
	if (summary) return { text: summary, source: "custom" };
	const description = String(book?.description || "").trim();
	if (description){
		return {
			text: description,
			source: "google",
			citationUrl: bookGoogleBooksUrl(book)
		};
	}
	return null;
}

function bookHasExpandableContent(book){
	return getBookDisplayBlurb(book) !== null;
}

function buildBookBlurbHtml(book, options = {}){
	const blurb = getBookDisplayBlurb(book);
	if (!blurb) return "";
	const showCitation = options.showCitation !== false;
	const citationClass = options.citationClass || "atlas-book-blurb-citation";
	let citationHtml = "";
	if (showCitation && blurb.source === "google" && blurb.citationUrl){
		citationHtml = `<a class="${citationClass}" href="${escapeHtml(blurb.citationUrl)}" target="_blank" rel="noopener">Google Books</a>`;
	}
	return `
  <div class="atlas-book-detail-description">
  <div class="atlas-book-detail-description-text">${escapeHtml(blurb.text)}</div>
  ${citationHtml}
  </div>
  `;
}

function buildBookTagsHtml(tags){
	const list = Array.isArray(tags) ? tags : [];
	if (!list.length) return "";

	const pills = list.slice(0, BOOK_TAG_COLORS.length).map((tag, idx) => {
		const text = String(tag || "").trim();
		if (!text) return "";
		return `<span class="atlas-book-tag" style="--tag-color:${BOOK_TAG_COLORS[idx]};">${escapeHtml(text)}</span>`;
	}).filter(Boolean).join("");

	if (!pills) return "";
	return `<div class="atlas-book-tags">${pills}</div>`;
}

function buildBookDetailHtml(book){
	const title = String(book.title || "").trim() || "Untitled";
	const author = String(book.author || "").trim() || "Unknown";
	const cover = String(book.cover_url || "").trim() || PLACEHOLDER_COVER;
	const safeAlt = `Cover of '${title}'`;
	const summaryHtml = buildBookBlurbHtml(book);
	const rawBuyUrl = String(book.bookshop_url || "").trim();
	const hasBuy = rawBuyUrl.length > 0;
	const isEditorRead = book.read === true;
	const tags = Array.isArray(book.tags) ? book.tags : [];

	let buyButtonHtml = "";
	if (hasBuy){
		buyButtonHtml = `<a class="atlas-book-buy" href="${escapeHtml(rawBuyUrl)}" target="_blank" rel="noopener">Buy</a>`;
	}

	let editorReadHtml = "";
	if (isEditorRead){
		editorReadHtml = `<div class="atlas-book-editor-read">Editor Read</div>`;
	}

	let tagsHtml = buildBookTagsHtml(tags);

	return `
  <div class="atlas-book-detail">
  <div class="atlas-book-detail-header">
   <div class="atlas-book-detail-toprow">
  <button type="button" class="atlas-book-back" aria-label="Close book">×</button>
   </div>
   <div class="atlas-book-detail-main">
  <img class="atlas-book-detail-cover" src="${cover}" alt="${escapeHtml(safeAlt)}" loading="lazy">
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
}

function buildBookExpandPanelHtml(book){
	const blurb = getBookDisplayBlurb(book);
	if (!blurb) return "";

	const summaryHtml = buildBookBlurbHtml(book, { showCitation: false });
	const footerParts = [];
	if (blurb.source === "google" && blurb.citationUrl){
		footerParts.push(`<a class="atlas-book-blurb-citation atlas-list-book-blurb-citation" href="${escapeHtml(blurb.citationUrl)}" target="_blank" rel="noopener">Google Books</a>`);
	}

	const footerHtml = footerParts.length
		? `<div class="atlas-list-book-panel-footer">${footerParts.join("")}</div>`
		: "";

	return summaryHtml + footerHtml;
}

function renderListViewBookRow(book, idx, iso, isExpanded){
	const title = String(book.title || "").trim() || "Untitled";
	const author = String(book.author || "").trim() || "Unknown";
	const cover = String(book.cover_url || "").trim() || PLACEHOLDER_COVER;
	const safeAlt = `Cover of '${title}'`;
	const tagsHtml = buildBookTagsHtml(book.tags);
	const isEditorRead = book.read === true;
	const editorReadHtml = isEditorRead
		? `<div class="atlas-book-editor-read">Editor Read</div>`
		: "";
	const expandable = bookHasExpandableContent(book);
	const rawBuyUrl = String(book.bookshop_url || "").trim();
	const hasBuy = rawBuyUrl.length > 0;
	const expandedClass = expandable && isExpanded ? " is-expanded" : "";
	const staticClass = expandable ? "" : " is-static";
	const ariaExpanded = expandable && isExpanded ? "true" : "false";
	const bookAttrs = expandable
		? `role="button" tabindex="0" aria-expanded="${ariaExpanded}"`
		: "";
	const hasActions = expandable || hasBuy;
	const bookActionClass = hasActions ? " atlas-book-has-actions" : "";
	const buyHtml = hasBuy
		? `<a class="atlas-book-buy atlas-list-book-buy" href="${escapeHtml(rawBuyUrl)}" target="_blank" rel="noopener">Buy</a>`
		: "";
	const chevronHtml = expandable
		? `<span class="atlas-list-book-chevron" aria-hidden="true"></span>`
		: "";
	const actionsHtml = hasActions
		? `<div class="atlas-list-book-actions">${buyHtml}${chevronHtml}</div>`
		: "";
	const panelHtml = expandable
		? `<div class="atlas-list-book-panel-wrap">
			<div class="atlas-list-book-panel">${buildBookExpandPanelHtml(book)}</div>
		</div>`
		: "";

	return `
	<div class="atlas-list-book-row${expandedClass}${staticClass}" data-iso="${escapeHtml(iso)}" data-idx="${idx}" data-book-id="${escapeHtml(book.id || "")}">
		<div class="atlas-book${bookActionClass}" ${bookAttrs}>
			<img class="atlas-book-cover" src="${cover}" alt="${escapeHtml(safeAlt)}" loading="lazy">
			<div class="atlas-list-book-main">
				${editorReadHtml}
				<div class="atlas-book-meta">
					<div class="atlas-book-title">${escapeHtml(title)}</div>
					<div class="atlas-book-author">${escapeHtml(author)}</div>
				</div>
				${tagsHtml}
			</div>
			${actionsHtml}
		</div>
		${panelHtml}
	</div>
	`;
}

function mountBookDetail(container, book, onBack){
	if (!container || !book) return;
	container.innerHTML = buildBookDetailHtml(book);
	attachCoverFallbacks(container);
	const backButton = container.querySelector(".atlas-book-back");
	if (backButton && typeof onBack === "function"){
		backButton.addEventListener("click", onBack);
	}
}

function showBookDetail(book, iso){
	if (!booksList || !emptyMsg || !book) return;

	selectedBook = book;
	if (infoBox) infoBox.classList.add("is-book-detail");

	mountBookDetail(booksList, book, () => {
		if (infoBox) infoBox.classList.remove("is-book-detail");
		renderBooks(lastBooksItems, lastBooksIso);
		requestAnimationFrame(placeInfoChip);
	});

	booksList.hidden = false;
	emptyMsg.hidden = true;
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
function getChatStackEl(){
	return chatRoot || chatShell;
}

function updateOverlayCssVars(){
	const headerH = atlasHeader ? Math.ceil(atlasHeader.getBoundingClientRect().height) + 20 : 72;
	document.documentElement.style.setProperty("--atlas-overlays-top", `${headerH}px`);
	const chatStackEl = getChatStackEl();
	if (chatStackEl){
		document.documentElement.style.setProperty("--atlas-chat-h", `${Math.ceil(chatStackEl.getBoundingClientRect().height)}px`);
	}
}

function getMapOverlayPadding(){
	updateOverlayCssVars();
	return MAP_CAMERA_PADDING;
}

function isMobile(){ return window.matchMedia("(max-width: 520px)").matches; }

function rectsOverlap(a,b){
	return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function placeInfoChip(){
	if (!infoBox || !infoBox.classList.contains("is-visible")) return;
	if (document.body.classList.contains("atlas-chat-expanded")) return;

	getMapOverlayPadding();

	if (!chatShell){
		infoBox.style.setProperty("--atlas-stack-extra", "0px");
		infoBox.classList.remove("stacked");
		return;
	}

	const chatStackEl = getChatStackEl();
	const chatRect = chatStackEl ? chatStackEl.getBoundingClientRect() : chatShell.getBoundingClientRect();
	const chatH = Math.ceil(chatRect.height) || 56;
	infoBox.style.setProperty("--atlas-chat-h", `${chatH}px`);

	requestAnimationFrame(() => {
		if (!infoBox.classList.contains("is-visible")) return;
		const infoRect = infoBox.getBoundingClientRect();
		const chatRect2 = chatStackEl ? chatStackEl.getBoundingClientRect() : chatShell.getBoundingClientRect();
		if (rectsOverlap(infoRect, chatRect2)){
			const overlapPx = Math.max(0, Math.ceil(infoRect.bottom - chatRect2.top + 12));
			infoBox.style.setProperty("--atlas-stack-extra", `${overlapPx}px`);
			infoBox.classList.add("stacked");
		} else {
			infoBox.style.setProperty("--atlas-stack-extra", "0px");
			infoBox.classList.remove("stacked");
		}
	});
}

function showInfo(iso,name){
	infoFlag.textContent = isoToFlagEmoji(iso);
	infoName.textContent = name || iso || "—";
	updateBookCountLabel(null);
	if (infoBox) infoBox.classList.remove("is-book-detail");

	booksList.innerHTML = buildLoadingSkeleton();
	booksList.hidden = false;
	emptyMsg.hidden = true;
	infoBox.classList.add("is-visible");
	requestAnimationFrame(placeInfoChip);

	lastBooksIso = iso;
	fetchBooksByCountry(iso)
	.then(items => { if (iso === lastBooksIso) renderBooks(items, iso); })
	.catch(err => { console.error(err); if (iso === lastBooksIso) renderBooks([], iso, { status: "error" }); });
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
	const padding = getMapOverlayPadding();
	map.fitBounds(clamped, {
		padding,
		maxZoom: Math.min(4.5, MAX_ZOOM),
		duration: SELECT_DURATION_MS,
		linear: false
	});
}
function centerOnBounds(bbox) {
	if (!bbox || bbox.length !== 4) return;
	const [[w,s],[e,n]] = [[bbox[0], bbox[1]],[bbox[2], bbox[3]]];
	const clamped = clampBoundsLat([[w,s],[e,n]]);
	const padding = getMapOverlayPadding();
	map.fitBounds(clamped, {
		padding,
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

	const infoName = String(name || "").trim() || fullCountryName(iso, "");
	const baseLabel = labelTextFromLabelLayers(iso) || infoName;
	const labelText = baseLabel ? baseLabel.toUpperCase() : infoName.toUpperCase();
	const pt = updateSelectedLabelAndPoint(iso, labelText, pickedFeature);

	if (pickedFeature) {
		centerOnFeature(pickedFeature);
	} else if (pt) {
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
	const pad = isMobile() ? 18 : 10;
	const box=[[point.x-pad,point.y-pad],[point.x+pad,point.y+pad]];
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
	applyMapSurfaceColor();
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
			"fill-color": countryFillPaintExpr(),
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
			const records = await loadAllBooks();
			console.log("[atlas] prewarmed", records.length, "book(s)");
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
const chatFollowupsBar = document.getElementById("atlas-chat-followups");

const CHAT_STORAGE_KEY = "atlas_curator_chat_v1";

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
		if (chatBody) chatBody.setAttribute("aria-hidden", "false");
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
	if (chatBody) chatBody.setAttribute("aria-hidden", "true");
	if (!preserve){
		chatIntroInjected = false;
		chatHasUserMessage = false;
		if (chatThread) chatThread.innerHTML = "";
		chatMessages = [];
		hideFollowUpBar();
		try { sessionStorage.removeItem(CHAT_STORAGE_KEY); } catch {}
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

function hideFollowUpBar(){
	if (!chatFollowupsBar) return;
	chatFollowupsBar.innerHTML = "";
	chatFollowupsBar.hidden = true;
	requestAnimationFrame(placeInfoChip);
}

function renderFollowUpBar(questions){
	if (!chatFollowupsBar) return;
	chatFollowupsBar.innerHTML = "";
	const qs = Array.isArray(questions)
		? questions.map(q => String(q || "").trim()).filter(Boolean)
		: [];
	if (!qs.length || !chatIsExpanded || chatIsSending){
		hideFollowUpBar();
		return;
	}
	for (const q of qs.slice(0, 2)){
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "atlas-chat-followup";
		btn.textContent = q;
		btn.addEventListener("click", () => {
			hideFollowUpBar();
			expandChat("followup_chip");
			submitChat(q, "followup_chip");
		});
		chatFollowupsBar.appendChild(btn);
	}
	chatFollowupsBar.hidden = false;
	requestAnimationFrame(placeInfoChip);
}

function saveChatSession(){
	try {
		const payload = {
			messages: chatMessages
				.filter(m => !m.isLoading)
				.map(m => ({
					role: m.role,
					text: m.text,
					markdown: m.markdown,
					recommendations: m.recommendations || [],
					followUpQuestions: m.followUpQuestions || []
				})),
			hasUserMessage: chatHasUserMessage
		};
		sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
	} catch (err) {
		console.warn("[atlas chat] save session failed", err);
	}
}

function restoreChatSession(){
	try {
		const raw = sessionStorage.getItem(CHAT_STORAGE_KEY);
		if (!raw) return;
		const payload = JSON.parse(raw);
		if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) return;

		chatMessages = [];
		if (chatThread) chatThread.innerHTML = "";
		chatIntroInjected = true;
		chatHasUserMessage = !!payload.hasUserMessage;

		for (const m of payload.messages){
			if (m.role === "user"){
				addChatMessage("user", m.text || "", {});
			} else if (m.role === "assistant"){
				addChatMessage("assistant", m.markdown || "", {
					recommendations: m.recommendations || [],
					followUpQuestions: m.followUpQuestions || []
				});
			}
		}

		const lastAssistant = [...chatMessages].reverse().find(m => m.role === "assistant" && !m.isLoading);
		if (lastAssistant && lastAssistant.followUpQuestions?.length){
			renderFollowUpBar(lastAssistant.followUpQuestions);
		}
	} catch (err) {
		console.warn("[atlas chat] restore session failed", err);
	}
}

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
				renderRecommendationCards(recWrap, message.recommendations, message.books);
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
		books: payload && Array.isArray(payload.books) ? payload.books : [],
		actions: payload && Array.isArray(payload.actions) ? payload.actions : [],
		element: null
	};
	chatMessages.push(msg);
	if (chatThread){
		chatThread.appendChild(createChatRowElement(msg));
		scrollChatToBottom();
		requestAnimationFrame(placeInfoChip);
	}
	if (!msg.isLoading) saveChatSession();
	return msg;
}

function replaceAssistantMessage(placeholder, assistantMarkdown, payload){
	if (!placeholder) return;
	placeholder.isLoading = false;
	placeholder.markdown = String(assistantMarkdown || "");
	placeholder.recommendations = payload && Array.isArray(payload.recommendations) ? payload.recommendations : [];
	placeholder.followUpQuestions = payload && Array.isArray(payload.followUpQuestions) ? payload.followUpQuestions : [];
	placeholder.actions = payload && Array.isArray(payload.actions) ? payload.actions : [];
	placeholder.books = payload && Array.isArray(payload.books) ? payload.books : [];

	if (!placeholder.element) return;
	const content = placeholder.element.querySelector(".atlas-chat-assistant");
	if (!content) return;

	content.classList.remove("is-loading");
	content.innerHTML = renderMarkdownToHtml(placeholder.markdown);

	if (placeholder.recommendations.length){
		const recWrap = document.createElement("div");
		recWrap.className = "atlas-chat-recs";
		content.appendChild(recWrap);
		renderRecommendationCards(recWrap, placeholder.recommendations, placeholder.books);
	}

	renderFollowUpBar(placeholder.followUpQuestions);
	saveChatSession();
	scrollChatToBottom();
	requestAnimationFrame(placeInfoChip);
}

let _booksByIdMapPromise = null;

async function ensureBooksByIdMap(){
	if (_booksByIdMapPromise) return _booksByIdMapPromise;
	_booksByIdMapPromise = (async () => {
		const records = await loadAllBooks();
		const byId = new Map();
		for (const r of records) byId.set(r.id, r);
		return byId;
	})();
	return _booksByIdMapPromise;
}

function primaryIsoForBook(book){
	const sets = book?.iso2Sets;
	if (!sets) return null;
	for (const key of ["override", "setting", "author"]) {
		const arr = sets[key];
		if (!Array.isArray(arr) || !arr.length) continue;
		for (const iso of arr) {
			if (typeof iso === "string" && iso.length === 2) return iso.toUpperCase();
		}
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

	if (viewMode === "list"){
		await openBookInListView(bookId);
		return;
	}

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

function renderRecommendationCards(container, recs, apiBooks){
	if (!container) return;
	container.innerHTML = "";
	const bookMap = new Map();
	if (Array.isArray(apiBooks)){
		for (const b of apiBooks){
			if (b && b.book_id) bookMap.set(String(b.book_id), b);
		}
	}
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
		cover.loading = "lazy";
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

		const hydrate = (book) => {
			if (!book) return;
			const safeTitle = String(book.title || "").trim() || "Untitled";
			const safeAuthor = String(book.author || "").trim() || "Unknown";
			const safeCover = String(book.cover_url || "").trim() || PLACEHOLDER_COVER;
			title.textContent = safeTitle;
			author.textContent = safeAuthor;
			cover.src = safeCover;
			card.disabled = false;
			card.addEventListener("click", () => openBookFromChat(bookId));
			attachCoverFallbacks(card);
		};

		const fromApi = bookMap.get(bookId);
		if (fromApi && fromApi.title){
			hydrate(fromApi);
		} else {
			ensureBooksByIdMap().then(byId => {
				const book = byId.get(bookId);
				if (book) hydrate(book);
			});
		}
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
	hideFollowUpBar();
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
		const followUps = Array.isArray(data.follow_up_questions) ? data.follow_up_questions : [];
		const books = Array.isArray(data.books) ? data.books : [];
		const actions = Array.isArray(data.actions) ? data.actions : [];

		replaceAssistantMessage(placeholder, assistantMarkdown, {
			recommendations,
			followUpQuestions: followUps,
			books,
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
			books: [],
			actions: []
		});
	} finally {
		setChatBusy(false);
	}
}

// ─────────── List view + filters ───────────
const VIEW_MODE_STORAGE_KEY = "atlas_view_mode_v1";
const listViewRoot = document.getElementById("atlas-list-view");
const listViewInner = document.getElementById("atlas-list-view-inner");
const filterToggleBtn = document.getElementById("atlas-filter-toggle");
const filterPanel = document.getElementById("atlas-filter-panel");
const filterBadge = document.getElementById("atlas-filter-badge");
const filterClearBtn = document.getElementById("atlas-filter-clear");
const filterCountryInput = document.getElementById("atlas-filter-country-input");
const filterCountryResults = document.getElementById("atlas-filter-country-results");
const filterTagsEl = document.getElementById("atlas-filter-tags");
const viewMapBtn = document.getElementById("atlas-view-map");
const viewListBtn = document.getElementById("atlas-view-list");
const topRightTools = document.querySelector(".atlas-top-right-tools");
const filterControlsEl = document.querySelector(".atlas-filter-controls");

let viewMode = "map";
let filterPanelOpen = false;
let listFilterCountry = null;
const listFilterTags = new Set();
let listSections = [];
let listViewLoading = false;
let listExpandedBookId = null;
let listScrollToBookId = null;
let filterCountryOptions = [];

function buildCountryFilterOptions(records){
	return computeOverrideIsoList(records).map(iso => ({
		iso,
		name: fullCountryName(iso)
	})).sort((a, b) => a.name.localeCompare(b.name));
}

function countryFilterMatches(query){
	const q = String(query || "").trim().toLowerCase();
	if (!q) return [];
	const matches = filterCountryOptions.filter(entry =>
		entry.name.toLowerCase().includes(q) || entry.iso.toLowerCase().includes(q)
	);
	matches.sort((a, b) => {
		const aName = a.name.toLowerCase();
		const bName = b.name.toLowerCase();
		const aStarts = aName.startsWith(q) ? 0 : 1;
		const bStarts = bName.startsWith(q) ? 0 : 1;
		if (aStarts !== bStarts) return aStarts - bStarts;
		return a.name.localeCompare(b.name);
	});
	return matches.slice(0, 14);
}

function hideCountryFilterResults(){
	if (!filterCountryResults) return;
	filterCountryResults.hidden = true;
	filterCountryResults.innerHTML = "";
}

function renderCountryFilterResults(query){
	if (!filterCountryResults) return;
	const q = String(query || "").trim();
	if (!q){
		hideCountryFilterResults();
		return;
	}

	const matches = countryFilterMatches(q);
	if (!matches.length){
		filterCountryResults.innerHTML = `<div class="atlas-filter-country-empty">No matches</div>`;
		filterCountryResults.hidden = false;
		return;
	}

	filterCountryResults.innerHTML = matches.map(entry => `
		<button type="button" class="atlas-filter-country" data-iso="${escapeHtml(entry.iso)}" role="option">
			<span class="atlas-filter-country-flag">${isoToFlagEmoji(entry.iso)}</span>
			<span>${escapeHtml(entry.name)}</span>
		</button>
	`).join("");
	filterCountryResults.hidden = false;
}

function syncCountryFilterInput(){
	if (!filterCountryInput) return;
	filterCountryInput.value = listFilterCountry ? fullCountryName(listFilterCountry) : "";
}

function selectCountryFilter(iso){
	listFilterCountry = iso ? String(iso).toUpperCase() : null;
	syncCountryFilterInput();
	hideCountryFilterResults();
	updateFilterBadge();
	if (viewMode === "list") renderListView();
}

function computeOverrideIsoList(records){
	const out = new Set();
	for (const rec of records){
		for (const iso of (rec.iso2Sets?.override || [])){
			if (iso && typeof iso === "string" && iso.length === 2 && iso !== "AQ") out.add(iso.toUpperCase());
		}
	}
	return Array.from(out).sort();
}

function computeAllTags(records){
	const out = new Set();
	for (const rec of records){
		for (const tag of (rec.tags || [])){
			const trimmed = String(tag || "").trim();
			if (trimmed) out.add(trimmed);
		}
	}
	return Array.from(out).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function applyListFilters(records, { countryIso, tags }){
	const country = countryIso ? String(countryIso).toUpperCase() : null;
	const tagList = Array.isArray(tags)
		? tags.filter(Boolean).map(t => String(t).toLowerCase())
		: [];

	return records.filter(rec => {
		const overrides = rec.iso2Sets?.override || [];
		if (!overrides.length) return false;

		// Country (when set) AND any selected tag (OR across tags).
		if (country && !overrides.includes(country)) return false;

		if (tagList.length){
			const bookTags = (rec.tags || []).map(t => String(t).toLowerCase());
			const matchesAnyTag = tagList.some(t => bookTags.includes(t));
			if (!matchesAnyTag) return false;
		}

		return true;
	});
}

function groupBooksByCountry(records){
	const groups = new Map();
	for (const rec of records){
		for (const iso of (rec.iso2Sets?.override || [])){
			if (!iso || iso === "AQ") continue;
			const key = iso.toUpperCase();
			if (!groups.has(key)){
				groups.set(key, { iso: key, name: fullCountryName(key), books: [] });
			}
			groups.get(key).books.push(rec);
		}
	}
	const sections = Array.from(groups.values());
	for (const section of sections){
		section.books.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
	}
	sections.sort((a, b) => a.name.localeCompare(b.name));
	return sections;
}

function hasActiveListFilters(){
	return !!(listFilterCountry || listFilterTags.size);
}

function updateFilterBadge(){
	if (!filterBadge) return;
	const active = viewMode === "list" && hasActiveListFilters();
	filterBadge.hidden = !active;
	if (filterToggleBtn){
		filterToggleBtn.classList.toggle("is-active", viewMode === "list" && (active || filterPanelOpen));
	}
	if (filterClearBtn){
		filterClearBtn.disabled = !active;
	}
}

function syncListFilterUi(){
	const listActive = viewMode === "list";
	if (filterControlsEl){
		filterControlsEl.setAttribute("aria-hidden", listActive ? "false" : "true");
	}
	if (!listActive){
		filterPanelOpen = false;
		if (filterPanel){
			filterPanel.classList.remove("is-expanded");
			filterPanel.classList.add("is-collapsed");
			filterPanel.setAttribute("aria-hidden", "true");
		}
		if (filterToggleBtn){
			filterToggleBtn.setAttribute("aria-expanded", "false");
		}
		hideCountryFilterResults();
	}
	updateFilterBadge();
}

function buildListLoadingSkeleton(){
	const row = `<div class="atlas-loading-row"><div class="atlas-loading-cover"></div><div class="atlas-loading-lines"><div class="atlas-loading-line long"></div><div class="atlas-loading-line short"></div></div></div>`;
	return `<div class="atlas-loading">${row.repeat(6)}</div>`;
}

function renderListSummary(){
	let pillsHtml = "";
	if (listFilterCountry){
		pillsHtml += `<span class="atlas-list-summary-pill">${isoToFlagEmoji(listFilterCountry)} ${escapeHtml(fullCountryName(listFilterCountry))}</span>`;
	}
	for (const tag of listFilterTags){
		pillsHtml += `<span class="atlas-list-summary-pill">${escapeHtml(tag)}</span>`;
	}
	if (!pillsHtml) return "";

	return `
		<div class="atlas-list-summary">
			<div class="atlas-list-summary-filters">${pillsHtml}</div>
		</div>
	`;
}

function renderFilterOptions(records){
	if (!filterTagsEl) return;

	filterCountryOptions = buildCountryFilterOptions(records);
	syncCountryFilterInput();

	for (const tag of listFilterTags){
		if (!isPublicBookTag(tag)) listFilterTags.delete(tag);
	}

	const tags = computeAllTags(records);
	filterTagsEl.innerHTML = tags.map((tag, idx) => {
		const selected = listFilterTags.has(tag);
		const color = BOOK_TAG_COLORS[idx % BOOK_TAG_COLORS.length];
		return `<button type="button" class="atlas-filter-chip${selected ? " is-selected" : ""}" data-tag="${escapeHtml(tag)}" style="--tag-color:${color};">${escapeHtml(tag)}</button>`;
	}).join("");

	updateFilterBadge();
}

function renderListSectionHeader(section){
	const count = section.books.length;
	const label = count === 1 ? "1 book" : `${count} books`;
	return `
		<header class="atlas-list-section-header">
			<span class="atlas-flag" role="img" aria-label="Country flag">${isoToFlagEmoji(section.iso)}</span>
			<span class="atlas-name">${escapeHtml(section.name)}</span>
			<span class="atlas-book-count">· ${label}</span>
		</header>
	`;
}

function getListViewScrollPaddingTop(){
	if (!listViewRoot) return 0;
	const raw = getComputedStyle(listViewRoot).scrollPaddingTop;
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : 0;
}

function scrollListViewToElement(targetEl, { behavior = "smooth" } = {}){
	if (!listViewRoot || !targetEl) return;
	const paddingTop = getListViewScrollPaddingTop();
	const scrollerRect = listViewRoot.getBoundingClientRect();
	const targetRect = targetEl.getBoundingClientRect();
	const nextTop = listViewRoot.scrollTop + (targetRect.top - scrollerRect.top) - paddingTop;
	listViewRoot.scrollTo({ top: Math.max(0, nextTop), behavior });
}

function scrollListViewToBookRow(rowEl){
	if (!rowEl) return;
	const section = rowEl.closest(".atlas-list-section");
	const header = section?.querySelector(".atlas-list-section-header");
	const booksWrap = section?.querySelector(".atlas-list-section-books");
	const isFirstInSection = booksWrap?.firstElementChild === rowEl;

	if (isFirstInSection && header){
		scrollListViewToElement(header);
		return;
	}

	const bookEl = rowEl.querySelector(".atlas-book") || rowEl;
	scrollListViewToElement(bookEl);
}

async function renderListView(){
	if (!listViewInner) return;

	listViewInner.innerHTML = buildListLoadingSkeleton();
	listViewLoading = true;

	try {
		const records = await loadAllBooks();
		renderFilterOptions(records);

		const filtered = applyListFilters(records, {
			countryIso: listFilterCountry,
			tags: Array.from(listFilterTags)
		});
		listSections = groupBooksByCountry(filtered);

		if (listExpandedBookId){
			const stillVisible = listSections.some(section =>
				section.books.some(book =>
					book.id === listExpandedBookId && bookHasExpandableContent(book)
				)
			);
			if (!stillVisible) listExpandedBookId = null;
		}

		if (!listSections.length){
			const msg = hasActiveListFilters()
				? "No books match these filters."
				: "No books are pinned to any country yet.";
			listViewInner.innerHTML = `<div class="atlas-list-empty">${escapeHtml(msg)}</div>`;
			return;
		}

		const html = renderListSummary() + listSections.map((section) => {
			const rows = section.books.map((book, idx) => {
				const expandable = bookHasExpandableContent(book);
				const isExpanded = expandable && listExpandedBookId && book.id === listExpandedBookId;
				return renderListViewBookRow(book, idx, section.iso, isExpanded);
			}).join("");
			return `<section class="atlas-list-section" data-iso="${escapeHtml(section.iso)}">
				${renderListSectionHeader(section)}
				<div class="atlas-list-section-books">${rows}</div>
			</section>`;
		}).join("");

		listViewInner.innerHTML = html;
		attachCoverFallbacks(listViewInner);

		const scrollBookId = listScrollToBookId;
		listScrollToBookId = null;
		const scrollTargetId = scrollBookId || listExpandedBookId;
		if (scrollTargetId){
			const targetRow = listViewInner.querySelector(`.atlas-list-book-row[data-book-id="${CSS.escape(scrollTargetId)}"]`);
			if (targetRow) requestAnimationFrame(() => scrollListViewToBookRow(targetRow));
		}
	} catch (err) {
		console.error("[atlas] list view render failed:", err);
		listViewInner.innerHTML = `<div class="atlas-list-empty">${escapeHtml(EMPTY_LOAD_ERROR_MSG)}</div>`;
	} finally {
		listViewLoading = false;
	}
}

function collapseListBookRows(root){
	if (!root) return;
	root.querySelectorAll(".atlas-list-book-row.is-expanded").forEach(rowEl => {
		rowEl.classList.remove("is-expanded");
		const toggle = rowEl.querySelector(".atlas-book");
		if (toggle) toggle.setAttribute("aria-expanded", "false");
	});
}

function toggleListBookRow(rowEl){
	if (!rowEl || rowEl.classList.contains("is-static")) return;
	const bookId = rowEl.getAttribute("data-book-id") || "";
	const wasExpanded = rowEl.classList.contains("is-expanded");
	collapseListBookRows(listViewInner);

	if (!wasExpanded){
		rowEl.classList.add("is-expanded");
		const toggle = rowEl.querySelector(".atlas-book");
		if (toggle) toggle.setAttribute("aria-expanded", "true");
		listExpandedBookId = bookId || null;
	} else {
		listExpandedBookId = null;
	}
}

async function openBookInListView(bookId){
	const records = await loadAllBooks();
	const book = records.find(r => r.id === bookId);
	listScrollToBookId = bookId;
	listExpandedBookId = book && bookHasExpandableContent(book) ? bookId : null;
	const filtered = applyListFilters(records, {
		countryIso: listFilterCountry,
		tags: Array.from(listFilterTags)
	});
	if (!filtered.some(r => r.id === bookId) && hasActiveListFilters()){
		listFilterCountry = null;
		listFilterTags.clear();
		syncCountryFilterInput();
		hideCountryFilterResults();
		updateFilterBadge();
		if (filterTagsEl){
			filterTagsEl.querySelectorAll(".atlas-filter-chip.is-selected").forEach(el => el.classList.remove("is-selected"));
		}
	}

	await renderListView();
}

function handleListViewClick(event){
	if (event.target.closest("a")) return;

	const rowEl = event.target.closest(".atlas-list-book-row");
	if (!rowEl || !listViewInner) return;
	if (!event.target.closest(".atlas-book")) return;

	toggleListBookRow(rowEl);
}

function handleListViewKeydown(event){
	if (event.key !== "Enter" && event.key !== " ") return;
	const bookEl = event.target.closest(".atlas-book");
	if (!bookEl || !listViewInner?.contains(bookEl)) return;
	event.preventDefault();
	toggleListBookRow(bookEl.closest(".atlas-list-book-row"));
}

function setViewMode(mode){
	const next = mode === "list" ? "list" : "map";
	if (viewMode === next) return;
	viewMode = next;

	if (viewMode === "list"){
		resetSelection();
		hideInfo();
		toggleFilterPanel(false);
		document.body.classList.add("atlas-view-list");
		renderListView();
	} else {
		document.body.classList.remove("atlas-view-list");
		listExpandedBookId = null;
	}

	syncListFilterUi();

	if (viewMapBtn){
		viewMapBtn.classList.toggle("is-active", viewMode === "map");
		viewMapBtn.setAttribute("aria-pressed", viewMode === "map" ? "true" : "false");
	}
	if (viewListBtn){
		viewListBtn.classList.toggle("is-active", viewMode === "list");
		viewListBtn.setAttribute("aria-pressed", viewMode === "list" ? "true" : "false");
	}

	try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode); } catch {}
	requestAnimationFrame(() => {
		getMapOverlayPadding();
		if (viewMode === "map") hardResize();
	});
}

function toggleFilterPanel(open){
	if (viewMode !== "list") return;

	const wantOpen = typeof open === "boolean" ? open : !filterPanelOpen;
	filterPanelOpen = wantOpen;
	if (filterPanel){
		filterPanel.classList.toggle("is-expanded", wantOpen);
		filterPanel.classList.toggle("is-collapsed", !wantOpen);
		filterPanel.setAttribute("aria-hidden", wantOpen ? "false" : "true");
	}
	if (!wantOpen) hideCountryFilterResults();
	if (filterToggleBtn){
		filterToggleBtn.setAttribute("aria-expanded", wantOpen ? "true" : "false");
		filterToggleBtn.classList.toggle("is-active", wantOpen || hasActiveListFilters());
	}
	updateFilterBadge();
}

function clearListFilters(){
	listFilterCountry = null;
	listFilterTags.clear();
	listExpandedBookId = null;
	syncCountryFilterInput();
	hideCountryFilterResults();
	updateFilterBadge();
	if (filterTagsEl){
		filterTagsEl.querySelectorAll(".atlas-filter-chip.is-selected").forEach(el => el.classList.remove("is-selected"));
	}
	if (viewMode === "list") renderListView();
	else loadAllBooks().then(renderFilterOptions).catch(() => {});
}

function setupListView(){
	if (!listViewRoot || !viewMapBtn || !viewListBtn) return;

	const restoreSavedView = () => {
		try {
			const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
			if (saved === "list") setViewMode("list");
		} catch {}
	};
	if (map.loaded()) restoreSavedView();
	else map.once("load", restoreSavedView);

	viewMapBtn.addEventListener("click", () => {
		toggleFilterPanel(false);
		setViewMode("map");
	});
	viewListBtn.addEventListener("click", () => setViewMode("list"));

	if (filterToggleBtn){
		filterToggleBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			toggleFilterPanel();
		});
	}

	if (filterClearBtn){
		filterClearBtn.addEventListener("click", () => clearListFilters());
	}

	if (filterCountryInput){
		filterCountryInput.addEventListener("input", () => {
			const val = filterCountryInput.value.trim();
			if (!val && listFilterCountry){
				listFilterCountry = null;
				updateFilterBadge();
				if (viewMode === "list") renderListView();
				hideCountryFilterResults();
				return;
			}
			if (listFilterCountry && fullCountryName(listFilterCountry) !== val){
				listFilterCountry = null;
				updateFilterBadge();
			}
			renderCountryFilterResults(filterCountryInput.value);
		});
		filterCountryInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape"){
				hideCountryFilterResults();
				filterCountryInput.blur();
			}
		});
		filterCountryInput.addEventListener("blur", () => {
			window.setTimeout(hideCountryFilterResults, 120);
		});
	}

	if (filterCountryResults){
		filterCountryResults.addEventListener("mousedown", (event) => {
			if (event.target.closest(".atlas-filter-country")) event.preventDefault();
		});
		filterCountryResults.addEventListener("click", (event) => {
			const btn = event.target.closest(".atlas-filter-country");
			if (!btn) return;
			const iso = btn.getAttribute("data-iso");
			if (!iso) return;
			selectCountryFilter(iso);
		});
	}

	if (filterTagsEl){
		filterTagsEl.addEventListener("click", (event) => {
			const btn = event.target.closest(".atlas-filter-chip");
			if (!btn) return;
			const tag = btn.getAttribute("data-tag");
			if (!tag) return;
			if (listFilterTags.has(tag)){
				listFilterTags.delete(tag);
				btn.classList.remove("is-selected");
			} else {
				listFilterTags.add(tag);
				btn.classList.add("is-selected");
			}
			updateFilterBadge();
			if (viewMode === "list") renderListView();
		});
	}

	if (listViewInner){
		listViewInner.addEventListener("click", handleListViewClick);
		listViewInner.addEventListener("keydown", handleListViewKeydown);
	}

	document.addEventListener("mousedown", (event) => {
		if (!filterPanelOpen) return;
		const target = event.target;
		if (topRightTools && topRightTools.contains(target)) return;
		toggleFilterPanel(false);
	});

	loadAllBooks().then(renderFilterOptions).catch(err => console.warn("[atlas] filter options prewarm failed", err));

	syncListFilterUi();
}

setupListView();

function dismissAppBanner(){
	if (!appBanner) return;
	appBanner.classList.add("is-dismissed");
	try { localStorage.setItem(APP_BANNER_DISMISS_KEY, "1"); } catch (_) {}
	updateOverlayCssVars();
	requestAnimationFrame(placeInfoChip);
}

function setupAppBanner(){
	if (!appBanner) return;
	try {
		if (localStorage.getItem(APP_BANNER_DISMISS_KEY) === "1"){
			appBanner.classList.add("is-dismissed");
		}
	} catch (_) {}

	if (appBannerDismiss){
		appBannerDismiss.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			dismissAppBanner();
		});
	}
}

function setupChat(){
	if (!chatInput || !chatSendButton) return;

	if (chatRoot){
		chatRoot.classList.add("is-collapsed");
		chatRoot.classList.remove("is-expanded");
	}
	if (chatBody) chatBody.setAttribute("aria-hidden", "true");
	document.body.classList.remove("atlas-chat-expanded");

	if (chatRoot && typeof ResizeObserver !== "undefined"){
		const chatResizeObserver = new ResizeObserver(() => {
			updateOverlayCssVars();
			if (!document.body.classList.contains("atlas-chat-expanded")){
				requestAnimationFrame(placeInfoChip);
			}
		});
		chatResizeObserver.observe(chatRoot);
	}

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
			hideFollowUpBar();
			try { sessionStorage.removeItem(CHAT_STORAGE_KEY); } catch {}
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
	restoreChatSession();
}
setupAppBanner();
setupChat();