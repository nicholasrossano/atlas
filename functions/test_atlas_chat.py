import unittest

from atlas_chat import (
	_attach_book_display,
	_build_tiered_candidates,
	_score_book_for_query,
	_validate_payload,
)


class TieredCandidatesTests(unittest.TestCase):
	def test_all_books_reachable_via_tier1_or_tier2(self):
		books = [
			{"id": "a", "title": "Alpha", "author": "A", "_blob": "alpha queer romance", "_iso2_sets": {"any": {"US"}}},
			{"id": "b", "title": "Beta", "author": "B", "_blob": "beta history", "_iso2_sets": {"any": {"FR"}}},
			{"id": "c", "title": "Gamma", "author": "C", "_blob": "gamma", "_iso2_sets": {"any": set()}},
		]
		tier1, tier2, stats = _build_tiered_candidates(books, "queer romance", "US")
		self.assertEqual(stats["total"], 3)
		self.assertGreaterEqual(stats["tier1"], 1)
		ids = {b["id"] for b in tier1} | {b["id"] for b in tier2}
		self.assertEqual(ids, {"a", "b", "c"})

	def test_score_boosts_selected_iso2(self):
		b = {"_blob": "book", "_iso2_sets": {"any": {"DE"}}}
		with_iso = _score_book_for_query(b, ["book"], "DE")
		without_iso = _score_book_for_query(b, ["book"], None)
		self.assertGreater(with_iso, without_iso)


class ValidatePayloadTests(unittest.TestCase):
	def test_attach_book_display(self):
		by_id = {
			"x": {"title": "Title", "author": "Author", "cover_url": "https://example.com/c.jpg"}
		}
		clean = _validate_payload({
			"assistant_markdown": "Try **Title** by Author.",
			"recommendations": [{"book_id": "x", "reason": "Great fit."}],
			"follow_up_questions": ["More like this?"],
			"actions": []
		}, by_id, "books")
		self.assertEqual(len(clean["recommendations"]), 1)
		self.assertEqual(clean["books"][0]["title"], "Title")
		self.assertEqual(clean["follow_up_questions"], ["More like this?"])

	def test_attach_books_empty_recs(self):
		clean = _attach_book_display({
			"assistant_markdown": "No match.",
			"recommendations": [],
			"follow_up_questions": [],
			"actions": [],
			"build": "test"
		}, {})
		self.assertEqual(clean["books"], [])


if __name__ == "__main__":
	unittest.main()
