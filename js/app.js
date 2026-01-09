// ─────────── Section Header ───────────
console.log("[atlas] app.js v16 booting");

// ─────────── Section Header ───────────
const MAPTILER_KEY = "pJYwuyZdJSSP0jFB9417";
const STYLE_ID     = "01980f6a-69a6-7821-b823-3068a302cdb6";
const API_ROOT     = "https://api.maptiler.com";
const STYLE_URL    = `${API_ROOT}/maps/${STYLE_ID}/style.json?key=${MAPTILER_KEY}`;
const SOURCE_ID    = "countries";
const SOURCE_LAYER = "administrative";
const HIGHLIGHT_COLOR = "#301900";
const BLUSH_COLOR = "#ECE4DB";
const MIN_ZOOM = 1, MAX_ZOOM = 1.8, INITIAL_CENTER = [0,0], INITIAL_ZOOM = 1.5;
const MIN_LAT = -60, MAX_LAT = 85;
const ZOOM_LABEL_SWITCH = 2.0;
const show = (msg, ...rest) => console.log(`[map] ${msg}`, ...rest);

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
	style: STYLE_URL,
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
let selectedIso = null;
let baseLabelLayerIds=[], borderLineLayerIds=[], continentLabelLayerIds=[], countryLabelLayerIds=[];

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
	if (propName && typeof propName === "string" && propName.trim().length > 2) return propName.trim();
	try { const dn = regionNames.of(iso); if (dn && dn.trim()) return dn; } catch {}
	return propName || iso || "—";
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
					overrideTokens: normalizeTokenList(data.country_override),
					settingTokens: normalizeTokenList(data.setting_country),
					authorCountryTokens: normalizeTokenList(data.author_country),
					authorOriginTokens: normalizeTokenList(data.author_origin)
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
		if (rec.overrideTokens && rec.overrideTokens.length){
			for (const t of rec.overrideTokens) if (t && t.length === 2) out.add(t);
			continue;
		}
		if (rec.settingTokens && rec.settingTokens.length){
			for (const t of rec.settingTokens) if (t && t.length === 2) out.add(t);
			continue;
		}
		for (const t of (rec.authorCountryTokens || [])) if (t && t.length === 2) out.add(t);
		for (const t of (rec.authorOriginTokens || []))  if (t && t.length === 2) out.add(t);
	}
	const arr = Array.from(out).filter(iso => iso !== "AQ").sort();
	return arr;
}

function availabilityPaintExpr(list){
	return [
		"case",
		["==", ["get","iso_a2"], "AQ"], "rgba(0,0,0,0)",
		["in", ["get","iso_a2"], ["literal", list]], HIGHLIGHT_COLOR,
		BLUSH_COLOR
	];
}

function updateAvailabilityStyle(){
	if (!map.getLayer(AVAIL_LAYER_ID)) return;
	try {
		map.setPaintProperty(AVAIL_LAYER_ID, "fill-color", availabilityPaintExpr(_availableIsoList));
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
		
		const items = records.filter(rec => {
			if (hasTokenMatch(rec.overrideTokens, normalizedCandidates)) return true;
			const hasSetting = rec.settingTokens && rec.settingTokens.length > 0;
			if (hasTokenMatch(rec.settingTokens, normalizedCandidates)) return true;
			if (!hasSetting) {
				if (hasTokenMatch(rec.authorCountryTokens, normalizedCandidates)) return true;
				if (hasTokenMatch(rec.authorOriginTokens, normalizedCandidates)) return true;
			}
			return false;
		});
		
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
   <div class="atlas-book-detail-title">${escapeHtml(title)}</div>
   <div class="atlas-book-detail-author">${escapeHtml(author)}</div>
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
const applyLabelModeForZoom=()=>{ if(selectedIso) return;
	const showContinents = map.getZoom() < ZOOM_LABEL_SWITCH;
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
	if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return [[-10,-10],[10,-10]];
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
	const clamped = clampBoundsLat(raw);
	map.fitBounds(clamped, {
		padding: { top: 90, right: 90, bottom: 100, left: 90 },
		maxZoom: Math.min(4.5, MAX_ZOOM),
		duration: 650,
		linear: true
	});
}
function centerOnBounds(bbox) {
	if (!bbox || bbox.length !== 4) return;
	const [[w,s],[e,n]] = [[bbox[0], bbox[1]],[bbox[2], bbox[3]]];
	const clamped = clampBoundsLat([[w,s],[e,n]]);
	map.fitBounds(clamped, {
		padding: { top: 90, right: 90, bottom: 100, left: 90 },
		maxZoom: Math.min(4.5, MAX_ZOOM),
		duration: 650,
		linear: true
	});
}

// ─────────── Section Header ───────────
const resetSelection=()=>{ selectedIso=null; const none=["==",["get","iso_a2"],"__none__"];
	[HIGHLIGHT_LAYER_ID, LABEL_LAYER_ID].forEach(id=>{ if(map.getLayer(id)){ map.setFilter(id,none); map.setLayoutProperty(id,"visibility","none"); }});
	if(map.getLayer(FADE_LAYER_ID)){ map.setLayoutProperty(FADE_LAYER_ID,"visibility","none"); map.setFilter(FADE_LAYER_ID,["!=",["get","iso_a2"],"AQ"]); }
	if(map.getLayer(AVAIL_LAYER_ID)){ map.setLayoutProperty(AVAIL_LAYER_ID,"visibility","visible"); }
	setVisibility(borderLineLayerIds,"visible"); setVisibility(baseLabelLayerIds,"visible");
	applyLabelModeForZoom(); hideInfo(); };

function selectIso(iso, name, options){
	if (chatIsExpanded) collapseChat("map_pick", { force: true, preserve: true });
	const opts = (options && typeof options === "object") ? options : {};
	const shouldShowInfo = !(opts.showInfo === false);
	const allowToggle = (opts.allowToggle !== false);
	if(!iso||iso==="AQ"){ resetSelection(); return; }
	if(allowToggle && iso===selectedIso){ resetSelection(); return; }
	selectedIso=iso;
	const highlightFilter=["==",["get","iso_a2"],iso];
	const fadeFilter=["all",["!=",["get","iso_a2"],iso],["!=",["get","iso_a2"],"AQ"]];
	map.setFilter(HIGHLIGHT_LAYER_ID,highlightFilter);
	map.setFilter(LABEL_LAYER_ID,highlightFilter);
	map.setFilter(FADE_LAYER_ID,fadeFilter);
	map.setLayoutProperty(HIGHLIGHT_LAYER_ID,"visibility","visible");
	map.setLayoutProperty(LABEL_LAYER_ID,"visibility","visible");
	map.setLayoutProperty(FADE_LAYER_ID,"visibility","visible");
	if(map.getLayer(AVAIL_LAYER_ID)) map.setLayoutProperty(AVAIL_LAYER_ID,"visibility","none");
	setVisibility(baseLabelLayerIds,"none");
	setVisibility(borderLineLayerIds,"none");
	clearSuggestions();
	if (shouldShowInfo) showInfo(iso,name);
}

function handlePickAtPoint(point){
	const pad=10; const box=[[point.x-pad,point.y-pad],[point.x+pad,point.y+pad]];
	const hit=map.queryRenderedFeatures(box,{layers:[HITBOX_LAYER_ID]});
	if(hit.length){
		const f   = hit[0];
		const iso = f?.properties?.iso_a2;
		const propName = f?.properties?.name_en ?? f?.properties?.NAME ?? f?.properties?.ADMIN ?? f?.properties?.name;
		const nice = fullCountryName(iso, propName);
		selectIso(iso, nice);
		centerOnFeature(f);
		requestAnimationFrame(placeInfoChip);
	} else {
		resetSelection();
	}
}

// ─────────── Section Header ───────────
map.on("load",()=>{ show("Map load OK"); hardResize();
	if(!map.getSource(SOURCE_ID)){ show(`Missing source '${SOURCE_ID}'`); return; }
	
	map.getStyle().layers.forEach(layer=>{
		if(layer.id.startsWith("oly-")) return;
		if(layer.type==="symbol"){
			baseLabelLayerIds.push(layer.id);
			const s=(layer["source-layer"]||"").toLowerCase(), id=(layer.id||"").toLowerCase();
			if(s.includes("continent")||id.includes("continent")) continentLabelLayerIds.push(layer.id);
			else if(s.includes("country")||id.includes("country")) countryLabelLayerIds.push(layer.id);
		}
		if(layer.type==="line" && typeof layer["source-layer"]==="string" &&
		   layer["source-layer"].toLowerCase().startsWith("boundary")){
			borderLineLayerIds.push(layer.id);
		}
	});
	
	const beforeBorders = borderLineLayerIds.length ? borderLineLayerIds[0] : undefined;
	
	map.addLayer({ id:AVAIL_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{ "fill-color": availabilityPaintExpr(_availableIsoList), "fill-opacity":0.85 },
		layout:{ visibility:"visible" },
		filter:["!=",["get","iso_a2"],"AQ"]
	}, beforeBorders);
	
	map.addLayer({ id:FADE_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{ "fill-color":"#ffffff", "fill-opacity":0.5 },
		layout:{ visibility:"none" },
		filter:["!=",["get","iso_a2"],"AQ"] });
	
	map.addLayer({ id:HIGHLIGHT_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{ "fill-color":HIGHLIGHT_COLOR, "fill-opacity":0.95 },
		layout:{ visibility:"none" },
		filter:["==",["get","iso_a2"],"__none__"] });
	
	map.addLayer({ id:LABEL_LAYER_ID, type:"symbol",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		layout:{ visibility:"none", "text-field":["get","name_en"], "text-size":14, "text-justify":"center",
			"text-anchor":"center", "text-allow-overlap":true, "text-font":["Open Sans Semibold","Arial Unicode MS Bold"] },
		paint:{ "text-color":"#111", "text-halo-color":"rgba(255,255,255,0.8)", "text-halo-width":1 },
		filter:["==",["get","iso_a2"],"__none__"] });
	
	map.addLayer({ id:HITBOX_LAYER_ID, type:"fill",
		source:SOURCE_ID, "source-layer":SOURCE_LAYER,
		paint:{ "fill-opacity":0 }, filter:["!=",["get","iso_a2"],"AQ"] });
	
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

	addChatMessage("assistant", "Tell me what kind of queer book you're looking for — vibe, setting, themes, anything. I’ll only recommend from the Atlas list.", {
		recommendations: [],
		followUpQuestions: [],
		actions: []
	});
	chatIntroInjected = true;
	setChatBusy(false);
}

const ATLAS_CHAT_ENDPOINT = (typeof window.ATLAS_CHAT_ENDPOINT === "string" && window.ATLAS_CHAT_ENDPOINT.trim().length > 0)
	? window.ATLAS_CHAT_ENDPOINT.trim()
	: "/api/atlasChat";

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
	const pickToken = (arr) => {
		if (!Array.isArray(arr)) return null;
		for (const item of arr){
			if (typeof item === "string" && item.length === 2) return item.toUpperCase();
		}
		return null;
	};
	return pickToken(book?.overrideTokens) ||
		pickToken(book?.settingTokens) ||
		pickToken(book?.authorCountryTokens) ||
		pickToken(book?.authorOriginTokens) ||
		null;
}

function featureForIso(iso){
	if (!iso || !map) return null;
	const clean = String(iso || "").toUpperCase();

	try {
		if (map.loaded && map.loaded()) {
			const feats = map.querySourceFeatures(SOURCE_ID, { sourceLayer: SOURCE_LAYER }) || [];
			for (const f of feats){
				const v = String(f?.properties?.iso_a2 || "").toUpperCase();
				if (v === clean) return f;
			}
		}
	} catch {}

	try {
		const feats2 = map.queryRenderedFeatures(undefined, { layers: [HITBOX_LAYER_ID] }) || [];
		for (const f of feats2){
			const v = String(f?.properties?.iso_a2 || "").toUpperCase();
			if (v === clean) return f;
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
