#!/usr/bin/env python3
"""Backfill google_books_url and missing cover_url on atlasBooks from Google Books.

Phase 1: derive google_books_url from an existing cover_url volume id (no API).
Phase 2: Google Books Volume API lookup for books still missing a link/cover.
Only confident title/author (or ISBN) matches are auto-applied; ambiguous rows go to CSV.

  python functions/scripts/backfill_google_books.py
  python functions/scripts/backfill_google_books.py --only-missing-link --apply
  GOOGLE_BOOKS_API_KEY=... python functions/scripts/backfill_google_books.py --only-lookup --apply
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
	from firebase_admin import firestore, initialize_app, get_app
except ImportError:
	print("firebase_admin not installed; activate functions/venv first", file=sys.stderr)
	sys.exit(1)

USER_AGENT = "AtlasGoogleBooksBackfill/1.0 (+https://map.ponder-app.ai)"
GOOGLE_ID_RE = re.compile(r"[?&]id=([^&]+)")
ISBN_RE = re.compile(r"/(\d{13})(?:\?|$)")
CONFIDENT_SCORE = 85
API_DELAY_SEC = 3.0
API_429_BASE_SEC = 15.0


def _norm(text: str) -> str:
	out = unicodedata.normalize("NFKD", (text or "").lower())
	out = "".join(ch for ch in out if not unicodedata.combining(ch))
	out = re.sub(r"[^a-z0-9]+", " ", out)
	return re.sub(r"\s+", " ", out).strip()


def _tokens(text: str) -> set[str]:
	return {t for t in _norm(text).split() if len(t) > 2}


def _primary_author(author: str) -> str:
	return (author or "").split(",")[0].split(";")[0].split(" and ")[0].strip()


def _volume_id_from_cover(cover_url: str) -> str:
	match = GOOGLE_ID_RE.search(cover_url or "")
	return match.group(1) if match else ""


def _google_books_url(volume_id: str) -> str:
	return f"https://books.google.com/books?id={volume_id}"


def _cover_url_from_volume_id(volume_id: str) -> str:
	return (
		f"https://books.google.com/books/content?id={volume_id}"
		"&printsec=frontcover&img=1&zoom=1&source=gbs_api"
	)


def _extract_isbn13(data: dict[str, Any]) -> str:
	for key in ("isbn13", "isbn_13", "isbn"):
		val = str(data.get(key) or "").strip()
		if re.fullmatch(r"\d{13}", val):
			return val
	bookshop = str(data.get("bookshop_url") or "")
	match = ISBN_RE.search(bookshop)
	return match.group(1) if match else ""


def _resolved_volume_id(data: dict[str, Any]) -> str:
	for key in ("google_books_url", "info_link", "preview_link"):
		val = str(data.get(key) or "")
		match = GOOGLE_ID_RE.search(val)
		if match:
			return match.group(1)
	vid = _volume_id_from_cover(str(data.get("cover_url") or ""))
	return vid


@dataclass
class Proposal:
	doc_id: str
	title: str
	author: str
	action: str
	score: int
	volume_id: str
	google_books_url: str
	cover_url: str
	matched_title: str
	matched_authors: str
	notes: str

	def as_row(self) -> dict[str, Any]:
		return {
			"doc_id": self.doc_id,
			"title": self.title,
			"author": self.author,
			"action": self.action,
			"score": self.score,
			"volume_id": self.volume_id,
			"google_books_url": self.google_books_url,
			"cover_url": self.cover_url,
			"matched_title": self.matched_title,
			"matched_authors": self.matched_authors,
			"notes": self.notes,
			"apply": "yes" if self.action in ("backfill_link", "lookup") and self.score >= CONFIDENT_SCORE else "",
		}


def _compact(text: str) -> str:
	return _norm(text).replace(" ", "")


def _lookup_queries(title: str, author: str) -> list[str]:
	primary = _primary_author(author)
	queries: list[str] = []
	if not title:
		return queries
	short_title = title.split(":")[0].strip()
	if primary:
		queries.append(f'intitle:"{title}" inauthor:"{primary}"')
		if short_title != title:
			queries.append(f'intitle:"{short_title}" inauthor:"{primary}"')
		queries.append(f"{title} {primary}")
		if short_title != title:
			queries.append(f"{short_title} {primary}")
		last_name = primary.split()[-1] if primary.split() else ""
		if last_name and len(last_name) > 3:
			queries.append(f"{title} {last_name}")
		# Common catalog typo: one word vs two (Highschool / High School).
		if re.fullmatch(r"(?i)highschool", short_title.strip()):
			queries.append(f'intitle:"High School" inauthor:"{primary}"')
		if " " not in short_title and len(short_title) > 6:
			spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", short_title)
			if spaced != short_title:
				queries.append(f"{spaced} {primary}")
	else:
		queries.append(title)
	return queries


def _score_volume(book_title: str, book_author: str, volume_info: dict[str, Any]) -> int:
	want_title = _norm(book_title)
	got_title = _norm(volume_info.get("title") or "")
	want_author = _norm(_primary_author(book_author))
	got_author = _norm(" ".join(volume_info.get("authors") or []))

	score = 0
	if want_title and got_title:
		if want_title == got_title:
			score += 100
		elif want_title in got_title or got_title in want_title:
			score += 78
		elif _compact(want_title) and _compact(got_title) and (
			_compact(want_title) in _compact(got_title) or _compact(got_title) in _compact(want_title)
		):
			score += 88
		else:
			overlap = len(_tokens(book_title) & _tokens(volume_info.get("title") or ""))
			if overlap >= 2:
				score += overlap * 15
			elif overlap == 1:
				score += 8

	if want_author and got_author:
		want_toks = _tokens(want_author)
		got_toks = _tokens(got_author)
		if want_toks & got_toks:
			score += 30
		elif any(tok in got_author for tok in want_author.split() if len(tok) > 2):
			score += 15
		# Last-name match with similar first initial (Abdullah/Abdellah Taia).
		elif len(want_toks) >= 1 and len(got_toks) >= 1:
			want_last = max(want_toks, key=len)
			got_last = max(got_toks, key=len)
			if want_last == got_last and len(want_last) > 3:
				score += 25

	# Short Google title with matching author (subtitle only in our catalog).
	if got_title and want_title and got_title in want_title and score >= 78:
		if want_author and got_author and (_tokens(want_author) & _tokens(got_author)):
			score = max(score, 92)

	bad_markers = (
		"summary of", "study guide", "box set", "analysis", "readings of",
		"comparative study", "sparknotes", "cliffnotes", "workbook", "coloring book",
	)
	got_lower = str(volume_info.get("title") or "").lower()
	if any(marker in got_lower for marker in bad_markers):
		score -= 80

	if want_title and got_title and want_title != got_title:
		if got_title not in want_title and want_title not in got_title:
			if len(_tokens(book_title) & _tokens(volume_info.get("title") or "")) <= 1:
				score -= 30

	return score


def _gb_api_query(q: str, max_results: int = 5) -> list[dict[str, Any]]:
	params: dict[str, str | int] = {"q": q, "maxResults": max_results}
	api_key = os.environ.get("GOOGLE_BOOKS_API_KEY", "").strip()
	if api_key:
		params["key"] = api_key
	params_encoded = urllib.parse.urlencode(params)
	url = f"https://www.googleapis.com/books/v1/volumes?{params_encoded}"
	ctx = ssl.create_default_context()
	req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

	for attempt in range(8):
		try:
			with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
				payload = json.loads(resp.read())
			return payload.get("items") or []
		except urllib.error.HTTPError as exc:
			if exc.code in (429, 503) and attempt < 7:
				wait = API_429_BASE_SEC * (attempt + 1)
				print(f"  API {exc.code}; sleeping {wait:.0f}s...", file=sys.stderr)
				time.sleep(wait)
				continue
			if attempt < 7:
				time.sleep(2)
				continue
			raise
		except Exception:
			if attempt < 7:
				time.sleep(2)
				continue
			raise
	return []


def _best_lookup_match(title: str, author: str, isbn13: str) -> tuple[dict[str, Any] | None, int, str]:
	if isbn13:
		items = _gb_api_query(f"isbn:{isbn13}", max_results=3)
		time.sleep(API_DELAY_SEC)
		for item in items:
			vi = item.get("volumeInfo") or {}
			ids = vi.get("industryIdentifiers") or []
			if any(str(x.get("identifier") or "") == isbn13 for x in ids):
				return item, 100, "isbn"
		if len(items) == 1:
			return items[0], 95, "isbn_single_result"

	best_item: dict[str, Any] | None = None
	best_score = 0
	best_method = ""
	for q in _lookup_queries(title, author):
		items = _gb_api_query(q, max_results=5)
		time.sleep(API_DELAY_SEC)
		for item in items:
			vi = item.get("volumeInfo") or {}
			score = _score_volume(title, author, vi)
			if score > best_score:
				best_score = score
				best_item = item
				best_method = f"query:{q[:60]}"
		if best_score >= CONFIDENT_SCORE:
			break

	return best_item, best_score, best_method


def _proposal_from_item(
	doc_id: str,
	title: str,
	author: str,
	item: dict[str, Any],
	score: int,
	method: str,
	needs_cover: bool,
) -> Proposal:
	volume_id = str(item.get("id") or "")
	vi = item.get("volumeInfo") or {}
	matched_authors = ", ".join(vi.get("authors") or [])
	cover = _cover_url_from_volume_id(volume_id) if needs_cover else ""
	return Proposal(
		doc_id=doc_id,
		title=title,
		author=author,
		action="lookup",
		score=score,
		volume_id=volume_id,
		google_books_url=_google_books_url(volume_id),
		cover_url=cover,
		matched_title=str(vi.get("title") or ""),
		matched_authors=matched_authors,
		notes=method,
	)


def _load_proposals(
	limit: int = 0,
	lookup: bool = True,
	only_lookup: bool = False,
	only_missing_link: bool = False,
) -> list[Proposal]:
	db = firestore.client()
	all_docs = [(doc.id, doc.to_dict() or {}) for doc in db.collection("atlasBooks").stream()]
	proposals: list[Proposal] = []

	for doc_id, data in all_docs:
		title = str(data.get("title") or "")
		author = str(data.get("author") or "")
		cover = str(data.get("cover_url") or "").strip()
		google_url = str(data.get("google_books_url") or "").strip()
		volume_id = _resolved_volume_id(data)
		cover_id = _volume_id_from_cover(cover)

		if only_missing_link and google_url:
			continue

		if google_url and cover and not only_missing_link:
			continue

		if cover_id and not google_url:
			if only_lookup:
				continue
			proposals.append(Proposal(
				doc_id=doc_id,
				title=title,
				author=author,
				action="backfill_link",
				score=100,
				volume_id=cover_id,
				google_books_url=_google_books_url(cover_id),
				cover_url="",
				matched_title=title,
				matched_authors=author,
				notes="from_cover_url",
			))
			continue

		if not lookup:
			if not volume_id and not only_lookup:
				proposals.append(Proposal(
					doc_id=doc_id,
					title=title,
					author=author,
					action="needs_lookup",
					score=0,
					volume_id="",
					google_books_url="",
					cover_url="",
					matched_title="",
					matched_authors="",
					notes="skipped_api",
				))
			continue

		if volume_id:
			continue

		if limit and sum(1 for p in proposals if p.action in ("lookup", "no_match", "low_confidence")) >= limit:
			continue

		print(f"Looking up: {title} — {author}", file=sys.stderr)
		isbn13 = _extract_isbn13(data)
		try:
			item, score, method = _best_lookup_match(title, author, isbn13)
		except Exception as exc:
			proposals.append(Proposal(
				doc_id=doc_id,
				title=title,
				author=author,
				action="api_error",
				score=0,
				volume_id="",
				google_books_url="",
				cover_url="",
				matched_title="",
				matched_authors="",
				notes=str(exc),
			))
			continue
		if item and score >= CONFIDENT_SCORE:
			needs_cover = not cover or not _volume_id_from_cover(cover)
			proposals.append(_proposal_from_item(
				doc_id, title, author, item, score, method, needs_cover=needs_cover,
			))
		else:
			matched_title = ""
			matched_authors = ""
			if item:
				vi = item.get("volumeInfo") or {}
				matched_title = str(vi.get("title") or "")
				matched_authors = ", ".join(vi.get("authors") or [])
			proposals.append(Proposal(
				doc_id=doc_id,
				title=title,
				author=author,
				action="no_match" if not item else "low_confidence",
				score=score,
				volume_id=str(item.get("id") or "") if item else "",
				google_books_url=_google_books_url(str(item.get("id") or "")) if item and score >= CONFIDENT_SCORE else "",
				cover_url="",
				matched_title=matched_title,
				matched_authors=matched_authors,
				notes=method or "no_results",
			))

	proposals.sort(key=lambda p: (p.action not in ("backfill_link", "lookup"), p.title.lower()))
	return proposals


def _print_summary(proposals: list[Proposal]) -> None:
	from collections import Counter

	print(f"Proposals: {len(proposals)}")
	for key, count in Counter(p.action for p in proposals).most_common():
		print(f"  {key}: {count}")
	auto = [p for p in proposals if p.action in ("backfill_link", "lookup") and p.score >= CONFIDENT_SCORE]
	print(f"Auto-apply candidates (>={CONFIDENT_SCORE}): {len(auto)}")
	covers = sum(1 for p in auto if p.cover_url)
	print(f"  including new covers: {covers}")


def _write_csv(proposals: list[Proposal], out_path: Path) -> None:
	fieldnames = [
		"doc_id", "title", "author", "action", "score", "volume_id",
		"google_books_url", "cover_url", "matched_title", "matched_authors",
		"notes", "apply",
	]
	with out_path.open("w", newline="", encoding="utf-8") as handle:
		writer = csv.DictWriter(handle, fieldnames=fieldnames)
		writer.writeheader()
		for proposal in proposals:
			writer.writerow(proposal.as_row())


def _apply_proposals(proposals: list[Proposal], dry_run: bool, apply_ids: set[str]) -> int:
	db = firestore.client()
	applied = 0

	for proposal in proposals:
		if proposal.action not in ("backfill_link", "lookup"):
			continue
		if proposal.score < CONFIDENT_SCORE:
			continue
		if apply_ids and proposal.doc_id not in apply_ids:
			continue
		if not proposal.google_books_url:
			continue

		update: dict[str, Any] = {"google_books_url": proposal.google_books_url}
		if proposal.cover_url:
			update["cover_url"] = proposal.cover_url

		label = f"{proposal.doc_id} -> {proposal.google_books_url}"
		if proposal.cover_url:
			label += " (+ cover)"
		print(f"{'Would apply' if dry_run else 'Applying'} {label}")

		if not dry_run:
			db.collection("atlasBooks").document(proposal.doc_id).update(update)
		applied += 1

	return applied


def main() -> int:
	parser = argparse.ArgumentParser(description="Backfill google_books_url / cover_url on atlasBooks")
	parser.add_argument("--out", type=str, default="google_books_backfill.csv", help="CSV report path")
	parser.add_argument("--dry-run", action="store_true", default=True, help="Report only (default)")
	parser.add_argument("--apply", action="store_true", help="Write confident matches to Firestore")
	parser.add_argument("--ids", type=str, default="", help="Comma-separated doc IDs to apply")
	parser.add_argument("--limit", type=int, default=0, help="Max API lookups (0 = all)")
	parser.add_argument("--no-lookup", action="store_true", help="Only backfill links from existing covers")
	parser.add_argument("--only-lookup", action="store_true", help="Skip cover-id backfill; API lookup only")
	parser.add_argument("--only-missing-link", action="store_true", help="Lookup only books without google_books_url")
	args = parser.parse_args()

	if args.apply:
		args.dry_run = False

	try:
		get_app()
	except ValueError:
		initialize_app()

	proposals = _load_proposals(
		limit=args.limit,
		lookup=not args.no_lookup,
		only_lookup=args.only_lookup,
		only_missing_link=args.only_missing_link,
	)
	out_path = Path(args.out)
	_write_csv(proposals, out_path)
	_print_summary(proposals)
	print(f"Report: {out_path.resolve()}")

	apply_ids = {x.strip() for x in args.ids.split(",") if x.strip()}
	applied = _apply_proposals(proposals, dry_run=args.dry_run, apply_ids=apply_ids)
	if args.dry_run:
		print(f"Dry run — would apply {applied} update(s). Re-run with --apply to write.")
	else:
		print(f"Applied {applied} update(s).")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
