#!/usr/bin/env python3
"""Audit atlasBooks for missing country_override with inferrable setting/author ISO2.

Default is dry-run (report only). Use --apply to write approved overrides.

  python functions/scripts/audit_country_override.py --dry-run
  python functions/scripts/audit_country_override.py --apply --ids doc_id1,doc_id2
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

# Allow importing atlas_chat helpers when run from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
	from firebase_admin import firestore, initialize_app, get_app
except ImportError:
	print("firebase_admin not installed; activate functions/venv first", file=sys.stderr)
	sys.exit(1)

from atlas_chat import _extract_iso2_candidates  # noqa: E402


def _first_iso2(field) -> str | None:
	cands = _extract_iso2_candidates(field)
	return cands[0] if cands else None


def _propose_override(data: dict) -> tuple[str | None, str | None]:
	setting = _first_iso2(data.get("setting_country"))
	if setting:
		return setting, "setting_country"
	author = _first_iso2(data.get("author_country"))
	if author:
		return author, "author_country"
	origin = _first_iso2(data.get("author_origin"))
	if origin:
		return origin, "author_origin"
	return None, None


def main() -> int:
	parser = argparse.ArgumentParser(description="Audit/backfill country_override on atlasBooks")
	parser.add_argument("--dry-run", action="store_true", default=True, help="Report only (default)")
	parser.add_argument("--apply", action="store_true", help="Write overrides for selected rows")
	parser.add_argument("--ids", type=str, default="", help="Comma-separated doc IDs to apply")
	parser.add_argument("--out", type=str, default="country_override_audit.csv", help="CSV report path")
	args = parser.parse_args()

	if args.apply:
		args.dry_run = False

	try:
		get_app()
	except ValueError:
		initialize_app()

	db = firestore.client()
	apply_ids = {x.strip() for x in args.ids.split(",") if x.strip()}

	rows: list[dict] = []
	for doc in db.collection("atlasBooks").stream():
		data = doc.to_dict() or {}
		override = data.get("country_override")
		has_override = bool(str(override or "").strip()) or (
			isinstance(override, list) and any(str(x).strip() for x in override)
		)
		if has_override:
			continue

		iso2, source = _propose_override(data)
		if not iso2:
			continue

		rows.append({
			"doc_id": doc.id,
			"title": str(data.get("title") or ""),
			"proposed_override": iso2,
			"source_field": source or "",
		})

	out_path = Path(args.out)
	with out_path.open("w", newline="", encoding="utf-8") as f:
		writer = csv.DictWriter(f, fieldnames=["doc_id", "title", "proposed_override", "source_field"])
		writer.writeheader()
		writer.writerows(rows)

	print(f"Found {len(rows)} candidate(s). Report: {out_path}")

	if args.dry_run:
		print("Dry run — no writes.")
		return 0

	applied = 0
	for row in rows:
		if apply_ids and row["doc_id"] not in apply_ids:
			continue
		db.collection("atlasBooks").document(row["doc_id"]).update({
			"country_override": row["proposed_override"]
		})
		applied += 1
		print(f"Applied {row['doc_id']} -> {row['proposed_override']} ({row['source_field']})")

	print(f"Applied {applied} update(s).")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
