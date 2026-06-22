#!/usr/bin/env python3
"""Fix missing or placeholder cover_url on atlasBooks using Google Books.

Detects:
  - empty cover_url
  - known Google "Image not available" placeholder hashes (9103 and 1269 bytes)
  - tiny/broken cover responses

Resolution order:
  1. zoom=0 -> zoom=1 on existing Google cover URLs (common catalog bug)
  2. ISBN cover URL (from isbn* fields or bookshop_url) — no API key needed
  3. Google Books Volume API lookup by title/author/ISBN (fallback)

  python functions/scripts/fix_cover_urls.py
  python functions/scripts/fix_cover_urls.py --apply
  GOOGLE_BOOKS_API_KEY=... python functions/scripts/fix_cover_urls.py --apply
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import ssl
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
	from firebase_admin import firestore, initialize_app, get_app
except ImportError:
	print("firebase_admin not installed; activate functions/venv first", file=sys.stderr)
	sys.exit(1)

from scripts.backfill_google_books import (  # noqa: E402
	CONFIDENT_SCORE,
	_best_lookup_match,
	_cover_url_from_volume_id,
	_extract_isbn13,
	_google_books_url,
	_volume_id_from_cover,
)

USER_AGENT = "AtlasCoverFix/1.0 (+https://map.ponder-app.ai)"
PLACEHOLDER_HASHES = {
	"a64fa89d7ebc97075c1d363fc5fea71f",  # zoom=0 "Image not available" (9103 bytes)
	"e89e0e364e83c0ecfba5da41007c9a2c",  # no-cover ISBN / zoom=1 fallback (1269 bytes)
}
MIN_COVER_BYTES = 2000


def _fetch_cover_meta(url: str) -> tuple[str, int]:
	if not url:
		return "missing", 0
	ctx = ssl.create_default_context()
	req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
	try:
		with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
			data = resp.read()
			digest = hashlib.md5(data).hexdigest()
			if digest in PLACEHOLDER_HASHES:
				return "placeholder", len(data)
			if len(data) < MIN_COVER_BYTES:
				return "tiny", len(data)
			return digest, len(data)
	except Exception as exc:
		return f"error:{type(exc).__name__}", 0


def _fix_zoom(url: str) -> str:
	if "zoom=0" in url:
		return url.replace("zoom=0", "zoom=1")
	return url


def _cover_from_isbn(isbn13: str) -> str:
	return (
		f"https://books.google.com/books/content?vid=ISBN{isbn13}"
		"&printsec=frontcover&img=1&zoom=1&source=gbs_api"
	)


def _cover_is_usable(url: str) -> bool:
	meta, _size = _fetch_cover_meta(url)
	return meta not in ("missing", "placeholder", "tiny") and not str(meta).startswith("error")


def _cover_needs_fix(cover_url: str) -> tuple[bool, str]:
	if not cover_url:
		return True, "missing"
	meta, _size = _fetch_cover_meta(cover_url)
	if meta == "placeholder":
		return True, "placeholder"
	if meta == "tiny":
		return True, "tiny"
	if str(meta).startswith("error"):
		return meta, str(meta)
	return False, "ok"


def _load_all_books() -> list[tuple[str, dict[str, Any]]]:
	db = firestore.client()
	return [(doc.id, doc.to_dict() or {}) for doc in db.collection("atlasBooks").stream()]


def _scan_candidates(books: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
	candidates: list[dict[str, Any]] = []
	total = len(books)
	for idx, (doc_id, data) in enumerate(books, start=1):
		if idx == 1 or idx % 25 == 0 or idx == total:
			print(f"  scanning {idx}/{total}...", file=sys.stderr)
		cover = str(data.get("cover_url") or "").strip()
		needs, reason = _cover_needs_fix(cover)
		if not needs:
			continue
		candidates.append({
			"doc_id": doc_id,
			"title": str(data.get("title") or ""),
			"author": str(data.get("author") or ""),
			"reason": reason,
			"old_cover_url": cover,
			"google_books_url": str(data.get("google_books_url") or "").strip(),
			"isbn13": _extract_isbn13(data),
		})
	return candidates


def _try_zoom_cover(candidate: dict[str, Any]) -> dict[str, Any] | None:
	old_cover = candidate.get("old_cover_url") or ""
	if not old_cover or "zoom=0" not in old_cover:
		return None
	new_cover = _fix_zoom(old_cover)
	if not _cover_is_usable(new_cover):
		return None
	return {
		**candidate,
		"action": "fix_cover",
		"score": 100,
		"volume_id": "",
		"new_cover_url": new_cover,
		"new_google_books_url": "",
		"matched_title": candidate["title"],
		"matched_authors": candidate["author"],
		"notes": "zoom=1",
		"apply": "yes",
	}


def _try_isbn_cover(candidate: dict[str, Any]) -> dict[str, Any] | None:
	isbn13 = candidate.get("isbn13") or ""
	if not isbn13:
		return None
	new_cover = _cover_from_isbn(isbn13)
	if not _cover_is_usable(new_cover):
		return None
	return {
		**candidate,
		"action": "fix_cover",
		"score": 100,
		"volume_id": "",
		"new_cover_url": new_cover,
		"new_google_books_url": "",
		"matched_title": candidate["title"],
		"matched_authors": candidate["author"],
		"notes": f"isbn_cover:{isbn13}",
		"apply": "yes",
	}


def _resolve_via_api(candidate: dict[str, Any]) -> dict[str, Any]:
	title = candidate["title"]
	author = candidate["author"]
	isbn13 = candidate["isbn13"]
	old_google = candidate["google_books_url"]

	row: dict[str, Any] = {
		**candidate,
		"action": "pending",
		"score": 0,
		"volume_id": "",
		"new_cover_url": "",
		"new_google_books_url": "",
		"matched_title": "",
		"matched_authors": "",
		"notes": "",
		"apply": "",
	}

	print(f"API lookup: {title} — {author} ({candidate['reason']})", file=sys.stderr)
	try:
		item, score, method = _best_lookup_match(title, author, isbn13)
	except Exception as exc:
		row["action"] = "api_error"
		row["notes"] = str(exc)
		return row

	if not item or score < CONFIDENT_SCORE:
		row["action"] = "no_match" if not item else "low_confidence"
		row["score"] = score
		row["notes"] = method or "no_results"
		if item:
			vi = item.get("volumeInfo") or {}
			row["matched_title"] = str(vi.get("title") or "")
			row["matched_authors"] = ", ".join(vi.get("authors") or [])
			row["volume_id"] = str(item.get("id") or "")
		return row

	volume_id = str(item.get("id") or "")
	new_cover = _cover_url_from_volume_id(volume_id)
	new_google = _google_books_url(volume_id)
	vi = item.get("volumeInfo") or {}

	if not _cover_is_usable(new_cover):
		row["action"] = "no_usable_cover"
		row["score"] = score
		row["volume_id"] = volume_id
		row["new_cover_url"] = new_cover
		row["new_google_books_url"] = new_google
		row["matched_title"] = str(vi.get("title") or "")
		row["matched_authors"] = ", ".join(vi.get("authors") or [])
		row["notes"] = f"{method}; lookup cover still placeholder"
		return row

	old_vid = _volume_id_from_cover(candidate["old_cover_url"])
	if volume_id == old_vid and candidate["reason"] != "missing":
		row["action"] = "same_volume"
		row["score"] = score
		row["volume_id"] = volume_id
		row["notes"] = method
		return row

	row["action"] = "fix_cover"
	row["score"] = score
	row["volume_id"] = volume_id
	row["new_cover_url"] = new_cover
	row["new_google_books_url"] = new_google if new_google != old_google else ""
	row["matched_title"] = str(vi.get("title") or "")
	row["matched_authors"] = ", ".join(vi.get("authors") or [])
	row["notes"] = method
	row["apply"] = "yes"
	return row


def _write_csv(rows: list[dict[str, Any]], out_path: Path) -> None:
	fieldnames = [
		"doc_id", "title", "author", "reason", "action", "score",
		"volume_id", "old_cover_url", "new_cover_url",
		"google_books_url", "new_google_books_url", "isbn13",
		"matched_title", "matched_authors", "notes", "apply",
	]
	with out_path.open("w", newline="", encoding="utf-8") as handle:
		writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
		writer.writeheader()
		for row in rows:
			writer.writerow(row)


def _apply_rows(rows: list[dict[str, Any]], dry_run: bool, apply_ids: set[str]) -> int:
	db = firestore.client()
	applied = 0

	for row in rows:
		if row.get("action") != "fix_cover" or row.get("apply") != "yes":
			continue
		if apply_ids and row["doc_id"] not in apply_ids:
			continue
		if not row.get("new_cover_url"):
			continue

		update: dict[str, Any] = {"cover_url": row["new_cover_url"]}
		if row.get("new_google_books_url"):
			update["google_books_url"] = row["new_google_books_url"]

		label = f"{row['doc_id']} ({row['title'][:40]})"
		print(f"{'Would apply' if dry_run else 'Applying'} {label}")
		if not dry_run:
			db.collection("atlasBooks").document(row["doc_id"]).update(update)
		applied += 1

	return applied


def main() -> int:
	parser = argparse.ArgumentParser(description="Fix placeholder/missing covers on atlasBooks")
	parser.add_argument("--out", type=str, default="cover_fix_report.csv", help="CSV report path")
	parser.add_argument("--dry-run", action="store_true", default=True, help="Report only (default)")
	parser.add_argument("--apply", action="store_true", help="Write confident fixes to Firestore")
	parser.add_argument("--ids", type=str, default="", help="Comma-separated doc IDs to apply")
	parser.add_argument("--limit", type=int, default=0, help="Max API lookups (0 = all)")
	parser.add_argument("--skip-api", action="store_true", help="Only try ISBN cover URLs")
	args = parser.parse_args()

	if args.apply:
		args.dry_run = False

	try:
		get_app()
	except ValueError:
		initialize_app()

	print("Loading atlasBooks...", file=sys.stderr)
	books = _load_all_books()
	print(f"Loaded {len(books)} book(s). Scanning covers...", file=sys.stderr)
	candidates = _scan_candidates(books)
	print(f"Found {len(candidates)} book(s) with bad/missing covers", file=sys.stderr)

	rows: list[dict[str, Any]] = []
	api_queue: list[dict[str, Any]] = []
	for candidate in candidates:
		zoom_row = _try_zoom_cover(candidate)
		if zoom_row:
			rows.append(zoom_row)
			continue
		isbn_row = _try_isbn_cover(candidate)
		if isbn_row:
			rows.append(isbn_row)
			continue
		if args.skip_api:
			rows.append({**candidate, "action": "needs_api", "score": 0, "notes": "no isbn cover"})
		else:
			api_queue.append(candidate)

	api_limit = args.limit if args.limit else len(api_queue)
	for idx, candidate in enumerate(api_queue[:api_limit], start=1):
		print(f"[API {idx}/{min(api_limit, len(api_queue))}]", file=sys.stderr, end=" ")
		rows.append(_resolve_via_api(candidate))
		time.sleep(0.5)

	for candidate in api_queue[api_limit:]:
		rows.append({**candidate, "action": "skipped_api", "score": 0, "notes": "limit"})

	rows.sort(key=lambda row: (row.get("action") != "fix_cover", row.get("title", "").lower()))

	out_path = Path(args.out)
	_write_csv(rows, out_path)

	from collections import Counter

	print(f"Processed: {len(rows)}")
	for key, count in Counter(r.get("action", "") for r in rows).most_common():
		print(f"  {key}: {count}")
	fixable = [r for r in rows if r.get("action") == "fix_cover"]
	print(f"Fixable covers: {len(fixable)}")
	print(f"Report: {out_path.resolve()}")

	apply_ids = {x.strip() for x in args.ids.split(",") if x.strip()}
	applied = _apply_rows(rows, dry_run=args.dry_run, apply_ids=apply_ids)
	if args.dry_run:
		print(f"Dry run — would apply {applied} update(s). Re-run with --apply to write.")
	else:
		print(f"Applied {applied} update(s).")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
