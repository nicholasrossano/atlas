import os
import re
import time
import json
import logging
import traceback
from typing import Dict, Any, List, Tuple, Optional

import requests
from firebase_functions import https_fn
from firebase_admin import firestore, initialize_app, get_app

try:
	import pycountry  # optional; improves country-name hints + iso conversions
except Exception:
	pycountry = None

try:
	get_app()
except ValueError:
	initialize_app()

db = firestore.client()

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ATLAS_CHAT_MODEL = os.environ.get("ATLAS_CHAT_MODEL") or "gpt-4o-mini"
ATLAS_CHAT_CACHE_TTL_SEC = int(os.environ.get("ATLAS_CHAT_CACHE_TTL_SEC") or 600)
ATLAS_CHAT_DEBUG = (os.environ.get("ATLAS_CHAT_DEBUG") or "").strip() == "1"
ATLAS_CHAT_BUILD = os.environ.get("ATLAS_CHAT_BUILD") or "atlas_chat_2026_06_17b"

_ATLAS_BOOK_CACHE_TS = 0.0
_ATLAS_BOOK_CACHE: List[Dict[str, Any]] = []
_ATLAS_BOOK_BY_ID: Dict[str, Dict[str, Any]] = {}
_ATLAS_AVAILABLE_COUNTRIES_CACHE: List[Dict[str, str]] = []


# ─────────── Response helpers ───────────
def _json_response(body: Dict[str, Any], status: int = 200) -> https_fn.Response:
	headers = {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
	}
	return https_fn.Response(json.dumps(body, ensure_ascii=False), status=status, headers=headers)


def _normalize_text(s: Any) -> str:
	try:
		txt = str(s or "")
	except Exception:
		txt = ""
	txt = txt.strip().lower()
	txt = re.sub(r"[^a-z0-9]+", " ", txt)
	txt = re.sub(r"\s+", " ", txt).strip()
	return txt


def _country_string_to_iso2(val: Any) -> Optional[str]:
	if val is None:
		return None
	try:
		raw = str(val).strip()
	except Exception:
		return None
	if not raw:
		return None

	t = raw.strip()
	t = t.replace("_", " ").replace("-", " ").strip()

	if len(t) == 2 and t.isalpha():
		return t.upper()

	if len(t) == 3 and t.isalpha() and pycountry is not None:
		try:
			c = pycountry.countries.get(alpha_3=t.upper())
			if c and getattr(c, "alpha_2", None):
				return str(c.alpha_2).upper()
		except Exception:
			pass

	if pycountry is not None:
		try:
			c = pycountry.countries.lookup(raw)
			if c and getattr(c, "alpha_2", None):
				return str(c.alpha_2).upper()
		except Exception:
			pass

	return None


def _extract_iso2_candidates(val: Any) -> List[str]:
	out: List[str] = []

	def _add(x: Any):
		iso2 = _country_string_to_iso2(x)
		if iso2:
			out.append(iso2)

	if isinstance(val, dict):
		for key in ("iso2", "code", "country", "value", "name"):
			if key in val:
				_add(val.get(key))
		for v in val.values():
			if isinstance(v, str):
				_add(v)
			elif isinstance(v, list):
				for vv in v:
					_add(vv)
	elif isinstance(val, list):
		for item in val:
			_add(item)
	elif isinstance(val, str):
		raw = [p.strip() for p in re.split(r"[,;|/]", val) if p.strip()]
		for item in raw:
			_add(item)
	else:
		_add(val)

	seen = set()
	uniq: List[str] = []
	for x in out:
		if x in seen:
			continue
		seen.add(x)
		uniq.append(x)
	return uniq


def _iso2_to_country_name(iso2: str) -> str:
	code = str(iso2 or "").strip().upper()
	if not (len(code) == 2 and code.isalpha()):
		return ""
	if pycountry is not None:
		try:
			c = pycountry.countries.get(alpha_2=code)
			if c and getattr(c, "name", None):
				return str(c.name)
		except Exception:
			pass
	return code


# ─────────── Book indexing ───────────
def _places_for_book(b: Dict[str, Any]) -> Dict[str, List[Dict[str, str]]]:
	def build(field_name: str) -> List[Dict[str, str]]:
		out: List[Dict[str, str]] = []
		for iso2 in _extract_iso2_candidates(b.get(field_name)):
			name = _iso2_to_country_name(iso2)
			out.append({"iso2": iso2, "name": name or iso2})
		return out

	return {
		"override": build("country_override"),
		"setting": build("setting_country"),
		"author_country": build("author_country"),
		"author_origin": build("author_origin"),
	}


def _iso2_sets_for_book(b: Dict[str, Any]) -> Dict[str, set]:
	places = b.get("_places") or {}

	def as_set(key: str) -> set:
		arr = places.get(key) if isinstance(places, dict) else []
		if not isinstance(arr, list):
			return set()
		out = set()
		for x in arr:
			if isinstance(x, dict) and isinstance(x.get("iso2"), str):
				out.add(x["iso2"].upper())
		return out

	override = as_set("override")
	setting = as_set("setting")
	author = as_set("author_country") | as_set("author_origin")
	any_place = override | setting | author
	return {"override": override, "setting": setting, "author": author, "any": any_place}


def _build_book_search_blob(b: Dict[str, Any]) -> str:
	parts: List[str] = []
	for k in ("title", "author", "summary", "description", "year"):
		v = b.get(k) or ""
		if v:
			parts.append(str(v))

	for k in ("tags", "categories"):
		v = b.get(k) or []
		if isinstance(v, list):
			parts.extend([str(x) for x in v if str(x).strip()])
		elif isinstance(v, str) and v.strip():
			parts.append(v)

	for field in ("country_override", "setting_country", "author_country", "author_origin"):
		for iso2 in _extract_iso2_candidates(b.get(field)):
			parts.append(iso2)
			nm = _iso2_to_country_name(iso2)
			if nm and nm != iso2:
				parts.append(nm)

	return _normalize_text(" ".join(parts))


def _load_atlas_books_cached() -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]], List[Dict[str, str]]]:
	global _ATLAS_BOOK_CACHE_TS, _ATLAS_BOOK_CACHE, _ATLAS_BOOK_BY_ID, _ATLAS_AVAILABLE_COUNTRIES_CACHE

	now = time.time()
	if _ATLAS_BOOK_CACHE and (now - _ATLAS_BOOK_CACHE_TS) < ATLAS_CHAT_CACHE_TTL_SEC:
		return _ATLAS_BOOK_CACHE, _ATLAS_BOOK_BY_ID, _ATLAS_AVAILABLE_COUNTRIES_CACHE

	try:
		docs = db.collection("atlasBooks").stream()
	except Exception as e:
		logger.error(f"[atlasChat] Firestore stream error: {e}")
		return _ATLAS_BOOK_CACHE, _ATLAS_BOOK_BY_ID, _ATLAS_AVAILABLE_COUNTRIES_CACHE

	items: List[Dict[str, Any]] = []
	by_id: Dict[str, Dict[str, Any]] = {}

	for doc in docs:
		try:
			data = doc.to_dict() or {}
		except Exception:
			data = {}

		bid = doc.id
		rec: Dict[str, Any] = {
			"id": bid,
			"title": str(data.get("title") or "").strip(),
			"author": str(data.get("author") or "").strip(),
			"summary": str(data.get("summary") or "").strip(),
			"description": str(data.get("description") or "").strip(),
			"year": str(data.get("year") or "").strip(),
			"page_count": int(data.get("page_count") or 0),
			"tags": data.get("tags") if isinstance(data.get("tags"), list) else [],
			"categories": data.get("categories") if isinstance(data.get("categories"), list) else [],
			"country_override": data.get("country_override") if data.get("country_override") is not None else "",
			"setting_country": data.get("setting_country") if data.get("setting_country") is not None else [],
			"author_country": data.get("author_country") if data.get("author_country") is not None else [],
			"author_origin": data.get("author_origin") if data.get("author_origin") is not None else [],
			"cover_url": str(data.get("cover_url") or "").strip(),
			"bookshop_url": str(data.get("bookshop_url") or "").strip(),
		}

		rec["_places"] = _places_for_book(rec)
		rec["_iso2_sets"] = _iso2_sets_for_book(rec)
		rec["_blob"] = _build_book_search_blob(rec)

		items.append(rec)
		by_id[bid] = rec

	iso_set = set()
	for b in items:
		sets = b.get("_iso2_sets") or {}
		if isinstance(sets, dict):
			iso_set |= set(sets.get("any") or set())

	available: List[Dict[str, str]] = []
	for iso2 in sorted([x for x in iso_set if isinstance(x, str) and len(x) == 2]):
		nm = _iso2_to_country_name(iso2)
		available.append({"iso2": iso2, "name": nm or iso2})

	_ATLAS_BOOK_CACHE_TS = now
	_ATLAS_BOOK_CACHE = items
	_ATLAS_BOOK_BY_ID = by_id
	_ATLAS_AVAILABLE_COUNTRIES_CACHE = available

	logger.info(f"[atlasChat] cached atlasBooks={len(items)} countries={len(available)} build={ATLAS_CHAT_BUILD}")
	return items, by_id, available


# ─────────── OpenAI plumbing ───────────
def _call_openai(api_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
	r = requests.post(
		"https://api.openai.com/v1/responses",
		headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
		data=json.dumps(payload),
		timeout=45
	)
	if r.status_code >= 400:
		raise RuntimeError(f"OpenAI HTTP {r.status_code}: {r.text}")
	return r.json()


def _parse_output_text_json(resp_json: Dict[str, Any]) -> Dict[str, Any]:
	txt = resp_json.get("output_text")
	if isinstance(txt, str) and txt.strip():
		try:
			return json.loads(txt)
		except Exception:
			return {}

	try:
		out = resp_json.get("output") or []
		for item in out:
			if (item.get("type") == "message") and (item.get("role") == "assistant"):
				content = item.get("content") or []
				for c in content:
					if c.get("type") == "output_text" and isinstance(c.get("text"), str) and c.get("text").strip():
						try:
							return json.loads(c.get("text"))
						except Exception:
							return {}
	except Exception:
		pass

	return {}


# ─────────── Tiered candidate ranking (no exclusion) ───────────
TIER1_DETAIL_COUNT = int(os.environ.get("ATLAS_CHAT_TIER1_COUNT") or 50)

_QUERY_STOPWORDS = frozenset({
	"a", "an", "and", "any", "are", "book", "books", "for", "from", "in", "me", "my",
	"of", "or", "recommend", "recommendation", "recommendations", "some", "the", "to", "with",
})

_THEME_EXPANSIONS: Dict[str, List[str]] = {
	"queer": ["queer", "lgbtq", "lgbt", "lgbtqia", "gay", "lesbian", "bisexual", "trans", "transgender"],
	"lgbt": ["lgbt", "lgbtq", "lgbtqia", "queer", "gay", "lesbian", "bisexual", "trans", "transgender"],
	"lgbtq": ["lgbtq", "lgbt", "lgbtqia", "queer", "gay", "lesbian", "bisexual", "trans", "transgender"],
}

_REGION_KEYWORDS: Dict[str, frozenset] = {
	"africa": frozenset({
		"DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD", "CI", "DJ", "EG",
		"GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML",
		"MR", "MU", "MA", "MZ", "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD",
		"TZ", "TG", "TN", "UG", "ZM", "ZW",
	}),
	"asia": frozenset({
		"AF", "AM", "AZ", "BH", "BD", "BT", "BN", "KH", "CN", "GE", "IN", "ID", "IR", "IQ", "IL", "JP",
		"JO", "KZ", "KW", "KG", "LA", "LB", "MY", "MV", "MN", "MM", "NP", "KP", "OM", "PK", "PH", "QA",
		"SA", "SG", "KR", "LK", "SY", "TW", "TJ", "TH", "TL", "TR", "TM", "AE", "UZ", "VN", "YE",
	}),
	"europe": frozenset({
		"AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
		"HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL",
		"PT", "RO", "RU", "SM", "RS", "SK", "SI", "ES", "SE", "CH", "UA", "GB", "VA",
	}),
	"south america": frozenset({"AR", "BO", "BR", "CL", "CO", "EC", "GY", "PY", "PE", "SR", "UY", "VE"}),
	"north america": frozenset({"CA", "MX", "US", "GT", "HN", "SV", "NI", "CR", "PA", "BZ", "CU", "DO", "HT", "JM", "TT"}),
	"oceania": frozenset({"AU", "FJ", "KI", "MH", "FM", "NR", "NZ", "PW", "PG", "WS", "SB", "TO", "TV", "VU"}),
}


def _tokenize_query(text: str) -> List[str]:
	norm = _normalize_text(text)
	return [t for t in norm.split(" ") if len(t) >= 2 and t not in _QUERY_STOPWORDS]


def _expand_theme_tokens(tokens: List[str]) -> List[str]:
	seen: set = set()
	out: List[str] = []
	for tok in tokens:
		for candidate in [tok, *(_THEME_EXPANSIONS.get(tok) or [])]:
			if candidate in seen:
				continue
			seen.add(candidate)
			out.append(candidate)
	return out


def _infer_geo_iso2_from_query(user_text: str, available_countries: List[Dict[str, str]]) -> Optional[set]:
	available = {
		str(c.get("iso2") or "").upper()
		for c in (available_countries or [])
		if isinstance(c, dict) and isinstance(c.get("iso2"), str) and len(str(c.get("iso2"))) == 2
	}
	if not available:
		return None

	norm = _normalize_text(user_text)
	if not norm:
		return None

	matched: set = set()
	for keyword, region_iso in _REGION_KEYWORDS.items():
		kw = keyword.replace(" ", "")
		if keyword in norm or kw in norm.replace(" ", ""):
			matched |= (region_iso & available)

	for c in available_countries or []:
		if not isinstance(c, dict):
			continue
		iso2 = str(c.get("iso2") or "").upper()
		name = _normalize_text(c.get("name") or "")
		if iso2 in available and name and len(name) >= 4 and name in norm:
			matched.add(iso2)

	return matched if matched else None


def _theme_tokens_from_query(
	raw_tokens: List[str],
	expanded_tokens: List[str],
	geo_iso2: Optional[set],
	available_countries: List[Dict[str, str]]
) -> List[str]:
	geo_terms: set = set()
	for keyword in _REGION_KEYWORDS:
		for part in keyword.split():
			geo_terms.add(part)
	for c in available_countries or []:
		if not isinstance(c, dict):
			continue
		name = _normalize_text(c.get("name") or "")
		if name:
			for part in name.split():
				if len(part) >= 3:
					geo_terms.add(part)

	out: List[str] = []
	seen: set = set()
	for tok in expanded_tokens:
		if tok in geo_terms or tok in seen:
			continue
		seen.add(tok)
		out.append(tok)
	return out


def _book_geo_iso2(b: Dict[str, Any]) -> set:
	sets = b.get("_iso2_sets") or {}
	if not isinstance(sets, dict):
		return set()
	any_set = sets.get("any") or set()
	return set(any_set) if isinstance(any_set, set) else set()


def _book_matches_geo(b: Dict[str, Any], geo_iso2: Optional[set]) -> bool:
	if not geo_iso2:
		return True
	return bool(_book_geo_iso2(b) & geo_iso2)


def _book_matches_theme(b: Dict[str, Any], theme_tokens: List[str]) -> bool:
	if not theme_tokens:
		return True
	blob = str(b.get("_blob") or "")
	return any(tok in blob for tok in theme_tokens)


def _score_book_for_query(
	b: Dict[str, Any],
	query_tokens: List[str],
	selected_iso2: Optional[str],
	geo_iso2: Optional[set] = None,
	theme_tokens: Optional[List[str]] = None
) -> float:
	score = 0.0
	blob = str(b.get("_blob") or "")
	themes = theme_tokens if theme_tokens else query_tokens
	if themes and blob:
		for tok in themes:
			if tok in blob:
				score += 1.0
	if geo_iso2 and (_book_geo_iso2(b) & geo_iso2):
		score += 3.0
	if selected_iso2:
		sets = b.get("_iso2_sets") or {}
		if isinstance(sets, dict):
			any_set = sets.get("any") or set()
			if selected_iso2 in any_set:
				score += 0.5
	return score


def _build_tiered_candidates(
	all_books: List[Dict[str, Any]],
	user_text: str,
	selected_iso2: Optional[str],
	available_countries: Optional[List[Dict[str, str]]] = None
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, int]]:
	if not all_books:
		return [], [], {"tier1": 0, "tier2": 0, "total": 0}

	raw_tokens = _tokenize_query(user_text)
	expanded_tokens = _expand_theme_tokens(raw_tokens)
	geo_iso2 = _infer_geo_iso2_from_query(user_text, available_countries or [])
	theme_tokens = _theme_tokens_from_query(raw_tokens, expanded_tokens, geo_iso2, available_countries or [])

	scored: List[Tuple[float, str, Dict[str, Any]]] = []
	for b in all_books:
		bid = str(b.get("id") or "")
		scored.append((
			_score_book_for_query(b, expanded_tokens, selected_iso2, geo_iso2, theme_tokens),
			bid,
			b
		))

	scored.sort(key=lambda x: (-x[0], x[1]))

	tier1: List[Dict[str, Any]] = []
	tier1_ids: set = set()

	# Pin geo+theme matches so regional themed queries stay in the detailed tier.
	if geo_iso2 and theme_tokens:
		for b in all_books:
			if not _book_matches_geo(b, geo_iso2) or not _book_matches_theme(b, theme_tokens):
				continue
			bid = str(b.get("id") or "")
			if not bid or bid in tier1_ids:
				continue
			tier1.append(b)
			tier1_ids.add(bid)

	for _, _, b in scored:
		if len(tier1) >= TIER1_DETAIL_COUNT:
			break
		bid = str(b.get("id") or "")
		if not bid or bid in tier1_ids:
			continue
		tier1.append(b)
		tier1_ids.add(bid)

	tier2: List[Dict[str, Any]] = []
	for _, _, b in scored:
		bid = str(b.get("id") or "")
		if not bid or bid in tier1_ids:
			continue
		places = b.get("_places") or {}
		if not isinstance(places, dict):
			places = {}
		tier2.append({
			"id": b.get("id"),
			"title": b.get("title"),
			"author": b.get("author"),
			"tags": b.get("tags")[:12] if isinstance(b.get("tags"), list) else [],
			"categories": b.get("categories")[:8] if isinstance(b.get("categories"), list) else [],
			"places": places
		})

	stats = {"tier1": len(tier1), "tier2": len(tier2), "total": len(all_books)}
	return tier1, tier2, stats


def _compact_detail_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
	compact: List[Dict[str, Any]] = []
	for b in candidates:
		places = b.get("_places") or {}
		if not isinstance(places, dict):
			places = {}
		compact.append({
			"id": b.get("id"),
			"title": b.get("title"),
			"author": b.get("author"),
			"year": b.get("year"),
			"page_count": b.get("page_count"),
			"tags": b.get("tags")[:16] if isinstance(b.get("tags"), list) else [],
			"categories": b.get("categories")[:16] if isinstance(b.get("categories"), list) else [],
			"places": places,
			"summary": (b.get("summary") or b.get("description") or "")[:650]
		})
	return compact


# ─────────── Recommender (single LLM call) ───────────
def _recommend_with_llm(
	api_key: str,
	history: List[Dict[str, str]],
	user_text: str,
	selected_iso2: Optional[str],
	available_countries: List[Dict[str, str]],
	candidates: List[Dict[str, Any]],
	candidates_index: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
	compact = _compact_detail_candidates(candidates)
	index_compact = candidates_index if isinstance(candidates_index, list) else []

	instructions = (
		"You are Atlas, a book recommender.\n"
		"Your only hard constraint is: recommend ONLY books whose id appears in CANDIDATES_DETAIL or CANDIDATES_INDEX.\n"
		"CANDIDATES_INDEX lists every other catalog book by id/title/author/places with less metadata.\n\n"
		"Geography behavior:\n"
		"- The user's prompt is authoritative.\n"
		"- If the user mentions a specific country, ONLY return books tied to that country.\n"
		"- If the user mentions a continent/region (e.g., Africa, South America, Southeast Asia), infer the countries in that region using general world knowledge, then return books from those countries only.\n"
		"- Use AVAILABLE_COUNTRIES as the set of ISO2 codes that exist in the catalog; only choose ISO2 codes that are present there.\n"
		"- Match the user's requested geography primarily using places.override (country_override). If override is missing, fall back to setting/author.\n"
		"- selected_iso2 is a UI hint ONLY when the user did not specify a location.\n"
		"- If you cannot find any matching book(s) in CANDIDATES_DETAIL or CANDIDATES_INDEX for the user's geography constraint, return recommendations as an empty list and explain briefly in assistant_markdown.\n\n"
		"Output requirements:\n"
		"- assistant_markdown must be prose only (1–3 sentences). No headings, no bullet points, no numbered lists.\n"
		"- Each mentioned book must be formatted as: **Title** by Author.\n"
		"- If the user asks for a book, return exactly 1 recommendation. If they ask for recommendations, return up to 3.\n"
		"- assistant_markdown must mention ALL recommended books (and only those books).\n"
		"- Each recommendations[i].reason must be exactly 1 sentence grounded in metadata.\n"
		"- follow_up_questions should usually be empty.\n"
		"- actions must be an empty list.\n"
	)

	schema = {
		"type": "object",
		"additionalProperties": False,
		"properties": {
			"assistant_markdown": {"type": "string"},
			"recommendations": {
				"type": "array",
				"items": {
					"type": "object",
					"additionalProperties": False,
					"properties": {
						"book_id": {"type": "string"},
						"reason": {"type": "string"}
					},
					"required": ["book_id", "reason"]
				}
			},
			"follow_up_questions": {"type": "array", "items": {"type": "string"}},
			"actions": {
				"type": "array",
				"maxItems": 0,
				"items": {
					"type": "object",
					"additionalProperties": False,
					"properties": {},
					"required": []
				}
			}
		},
		"required": ["assistant_markdown", "recommendations", "follow_up_questions", "actions"]
	}

	context_obj = {
		"user_text": str(user_text or ""),
		"selected_iso2": str(selected_iso2 or ""),
		"available_countries": available_countries
	}

	input_items: List[Dict[str, Any]] = [
		{
			"role": "developer",
			"content": [{"type": "input_text", "text": "CONTEXT:\n" + json.dumps(context_obj, ensure_ascii=False)}]
		},
		{
			"role": "developer",
			"content": [{"type": "input_text", "text": "CANDIDATES_DETAIL:\n" + json.dumps(compact, ensure_ascii=False)}]
		},
		{
			"role": "developer",
			"content": [{"type": "input_text", "text": "CANDIDATES_INDEX:\n" + json.dumps(index_compact, ensure_ascii=False)}]
		}
	]

	for m in history[-12:]:
		role = (m.get("role") or "").strip().lower()
		content = (m.get("content") or "").strip()
		if role == "user" and content:
			input_items.append({"role": "user", "content": [{"type": "input_text", "text": content}]})
		elif role == "assistant" and content:
			input_items.append({"role": "assistant", "content": [{"type": "output_text", "text": content}]})

	payload = {
		"model": ATLAS_CHAT_MODEL,
		"instructions": instructions,
		"input": input_items,
		"text": {
			"format": {
				"type": "json_schema",
				"name": "atlas_chat_response",
				"strict": True,
				"schema": schema
			}
		},
		"temperature": 0.35,
		"max_output_tokens": 900
	}

	resp_json = _call_openai(api_key, payload)
	return _parse_output_text_json(resp_json)


# ─────────── Output cleanup/validation ───────────
def _sanitize_assistant_markdown(md: str) -> str:
	text = str(md or "").strip()
	if not text:
		return ""

	text = re.sub(r"(?m)^\s*#{1,6}\s*", "", text)
	text = re.sub(r"(?m)^\s*[-*•]\s+", "", text)
	text = re.sub(r"(?m)^\s*\d+\.\s+", "", text)
	text = re.sub(r"\n{3,}", "\n\n", text).strip()

	if len(text) > 900:
		text = text[:900].rstrip()

	return text


def _build_synced_markdown(by_id: Dict[str, Dict[str, Any]], clean_recs: List[Dict[str, str]]) -> str:
	if not clean_recs:
		return ""

	def _fmt(bid: str) -> Tuple[str, str]:
		b = by_id.get(bid) or {}
		title = str(b.get("title") or "").strip()
		author = str(b.get("author") or "").strip()
		return title, author

	if len(clean_recs) == 1:
		bid = clean_recs[0]["book_id"]
		title, author = _fmt(bid)
		reason = str(clean_recs[0].get("reason") or "").strip()
		if title and author:
			if reason:
				return _sanitize_assistant_markdown(f"I recommend **{title}** by {author}. {reason}")
			return _sanitize_assistant_markdown(f"I recommend **{title}** by {author}.")
		return ""

	items = clean_recs[:3]
	(t1, a1) = _fmt(items[0]["book_id"])

	if len(items) == 2:
		(t2, a2) = _fmt(items[1]["book_id"])
		if t1 and a1 and t2 and a2:
			return _sanitize_assistant_markdown(f"Two good picks: **{t1}** by {a1} and **{t2}** by {a2}.")
		if t1 and a1:
			return _sanitize_assistant_markdown(f"My top pick is **{t1}** by {a1}.")
		return ""

	(t2, a2) = _fmt(items[1]["book_id"])
	(t3, a3) = _fmt(items[2]["book_id"])
	if t1 and a1 and t2 and a2 and t3 and a3:
		return _sanitize_assistant_markdown(f"Three picks: **{t1}** by {a1}, **{t2}** by {a2}, and **{t3}** by {a3}.")
	if t1 and a1:
		return _sanitize_assistant_markdown(f"My top pick is **{t1}** by {a1}.")
	return ""


def _validate_payload(parsed: Dict[str, Any], by_id: Dict[str, Dict[str, Any]], user_text: str) -> Dict[str, Any]:
	assistant_markdown = _sanitize_assistant_markdown(parsed.get("assistant_markdown") if isinstance(parsed, dict) else "")
	recs = parsed.get("recommendations") if isinstance(parsed, dict) and isinstance(parsed.get("recommendations"), list) else []
	fups = parsed.get("follow_up_questions") if isinstance(parsed, dict) and isinstance(parsed.get("follow_up_questions"), list) else []

	clean_recs: List[Dict[str, str]] = []
	seen_ids = set()
	for r in recs:
		if not isinstance(r, dict):
			continue
		bid = r.get("book_id")
		reason = r.get("reason")
		if isinstance(bid, str) and bid in by_id and bid not in seen_ids:
			seen_ids.add(bid)
			clean_recs.append({"book_id": bid, "reason": str(reason or "").strip()[:240]})

	if len(clean_recs) > 3:
		clean_recs = clean_recs[:3]

	clean_fups: List[str] = []
	for q in fups[:2]:
		if isinstance(q, str) and q.strip():
			clean_fups.append(q.strip()[:180])

	if not clean_recs:
		if not assistant_markdown:
			assistant_markdown = "I couldn’t find a match for that in the Atlas catalog yet. Try a different country/region or tell me a different vibe, and I’ll stick to what’s in the list."
		return _attach_book_display({
			"assistant_markdown": assistant_markdown,
			"recommendations": [],
			"follow_up_questions": clean_fups,
			"actions": [],
			"build": ATLAS_CHAT_BUILD
		}, by_id)

	if assistant_markdown:
		md_norm = _normalize_text(assistant_markdown)
		all_ok = True
		for r in clean_recs:
			b = by_id.get(r["book_id"]) or {}
			title = str(b.get("title") or "").strip()
			if title and _normalize_text(title) not in md_norm:
				all_ok = False
				break
		if not all_ok:
			fallback_md = _build_synced_markdown(by_id, clean_recs)
			if fallback_md:
				assistant_markdown = fallback_md
	else:
		fallback_md = _build_synced_markdown(by_id, clean_recs)
		if fallback_md:
			assistant_markdown = fallback_md

	if not assistant_markdown:
		assistant_markdown = "Tell me what kind of story you're looking for, from themes to setting or anything else. I'll find the best fit from our library"

	out = {
		"assistant_markdown": assistant_markdown,
		"recommendations": clean_recs,
		"follow_up_questions": clean_fups,
		"actions": [],
		"build": ATLAS_CHAT_BUILD
	}
	return _attach_book_display(out, by_id)


def _attach_book_display(clean: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
	books: List[Dict[str, str]] = []
	for r in clean.get("recommendations") or []:
		if not isinstance(r, dict):
			continue
		bid = r.get("book_id")
		if not isinstance(bid, str):
			continue
		b = by_id.get(bid) or {}
		books.append({
			"book_id": bid,
			"title": str(b.get("title") or "").strip(),
			"author": str(b.get("author") or "").strip(),
			"cover_url": str(b.get("cover_url") or "").strip(),
		})
	clean["books"] = books
	return clean


def _catalog_already_fully_detailed(tier_stats: Dict[str, int]) -> bool:
	total = int(tier_stats.get("total") or 0)
	tier2 = int(tier_stats.get("tier2") or 0)
	return total > 0 and tier2 == 0


def _should_retry_full_catalog(
	parsed: Dict[str, Any],
	clean: Dict[str, Any],
	tier_stats: Dict[str, int]
) -> bool:
	if _catalog_already_fully_detailed(tier_stats):
		return False
	if not parsed:
		return True
	recs = clean.get("recommendations")
	return not (isinstance(recs, list) and recs)


# ─────────── HTTP Function ───────────
@https_fn.on_request(secrets=["OPENAI_API_KEY"])
def atlasChat(req: https_fn.Request) -> https_fn.Response:
	if req.method == "OPTIONS":
		return _json_response({"ok": True}, status=204)

	if req.method != "POST":
		return _json_response({"error": "method_not_allowed"}, status=405)

	try:
		body = req.get_json(silent=True) or {}
	except Exception:
		body = {}

	debug = bool(body.get("debug") is True) or ATLAS_CHAT_DEBUG

	context = body.get("context") if isinstance(body.get("context"), dict) else {}
	selected_iso2 = context.get("selected_iso2")
	if isinstance(selected_iso2, str):
		selected_iso2 = selected_iso2.strip().upper()
		if not (len(selected_iso2) == 2 and selected_iso2.isalpha()):
			selected_iso2 = None
	else:
		selected_iso2 = None

	messages = body.get("messages")
	if not isinstance(messages, list):
		messages = []

	last_user_text = ""
	for m in reversed(messages):
		if isinstance(m, dict) and (m.get("role") == "user") and isinstance(m.get("content"), str):
			txt = m.get("content").strip()
			if txt:
				last_user_text = txt
				break

	if not last_user_text:
		return _json_response({
			"assistant_markdown": "Tell me what kind of story you're looking for, from themes to setting or anything else. I'll find the best fit from our library",
			"recommendations": [],
			"follow_up_questions": [],
			"actions": [],
			"build": ATLAS_CHAT_BUILD
		}, status=200)

	all_books, by_id, available_countries = _load_atlas_books_cached()
	if not all_books:
		out = {"error": "catalog_unavailable", "build": ATLAS_CHAT_BUILD}
		if debug:
			out["debug"] = {
				"build": ATLAS_CHAT_BUILD,
				"firestore_emulator_host": os.environ.get("FIRESTORE_EMULATOR_HOST"),
				"gcloud_project": os.environ.get("GCLOUD_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT"),
			}
		return _json_response(out, status=500)

	api_key = os.environ.get("OPENAI_API_KEY") or ""
	if not api_key:
		out = {"error": "missing_openai_api_key", "build": ATLAS_CHAT_BUILD}
		if debug:
			out["debug"] = {"build": ATLAS_CHAT_BUILD}
		return _json_response(out, status=500)

	history: List[Dict[str, str]] = []
	for m in messages[-12:]:
		if not isinstance(m, dict):
			continue
		role = str(m.get("role") or "").strip().lower()
		content = m.get("content")
		if role in ("user", "assistant") and isinstance(content, str) and content.strip():
			history.append({"role": role, "content": content.strip()})

	try:
		tier1, tier2, tier_stats = _build_tiered_candidates(
			all_books, last_user_text, selected_iso2, available_countries
		)

		def _call_recommender(detail: List[Dict[str, Any]], index: List[Dict[str, Any]]) -> Dict[str, Any]:
			return _recommend_with_llm(
				api_key=api_key,
				history=history,
				user_text=last_user_text,
				selected_iso2=selected_iso2,
				available_countries=available_countries or [],
				candidates=detail,
				candidates_index=index
			)

		parsed = _call_recommender(tier1, tier2)
		clean = _validate_payload(parsed or {}, by_id, last_user_text)
		candidate_pass = "tiered"

		if _should_retry_full_catalog(parsed or {}, clean, tier_stats):
			parsed_full = _call_recommender(all_books, [])
			clean_full = _validate_payload(parsed_full or {}, by_id, last_user_text)
			candidate_pass = "full_catalog" if not parsed else "full_catalog_retry"
			clean = clean_full

		if debug:
			clean["debug"] = {
				"tier1": tier_stats.get("tier1"),
				"tier2": tier_stats.get("tier2"),
				"catalog_total": tier_stats.get("total"),
				"candidate_pass": candidate_pass,
				"countries": len(available_countries or []),
				"selected_iso2": selected_iso2,
				"model": ATLAS_CHAT_MODEL,
				"build": ATLAS_CHAT_BUILD
			}

		return _json_response(clean, status=200)

	except Exception as e:
		logger.error(f"[atlasChat] error: {e}\n{traceback.format_exc()}")

		out = {
			"assistant_markdown": "Sorry — something went wrong talking to the book brain. Try again in a sec.",
			"recommendations": [],
			"follow_up_questions": [],
			"actions": [],
			"build": ATLAS_CHAT_BUILD
		}

		if debug:
			err_text = f"{type(e).__name__}: {str(e)}"
			tb = traceback.format_exc()
			out["debug"] = {
				"error": err_text[:1800],
				"trace": tb[-3000:],
				"model": ATLAS_CHAT_MODEL,
				"has_key": True,
				"selected_iso2": selected_iso2,
				"build": ATLAS_CHAT_BUILD
			}

		return _json_response(out, status=200)
