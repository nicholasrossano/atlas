import unittest

from atlas_chat import (
	_attach_book_display,
	_book_record_for_client,
	_build_tiered_candidates,
	_catalog_already_fully_detailed,
	_infer_geo_iso2_from_query,
	_should_retry_full_catalog,
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
		tier1, tier2, stats = _build_tiered_candidates(books, "queer romance", "US", [])
		self.assertEqual(stats["total"], 3)
		self.assertGreaterEqual(stats["tier1"], 1)
		ids = {b["id"] for b in tier1} | {b["id"] for b in tier2}
		self.assertEqual(ids, {"a", "b", "c"})

	def test_score_boosts_selected_iso2(self):
		b = {"_blob": "book", "_iso2_sets": {"any": {"DE"}}}
		with_iso = _score_book_for_query(b, ["book"], "DE")
		without_iso = _score_book_for_query(b, ["book"], None)
		self.assertGreater(with_iso, without_iso)

	def test_african_queer_book_pinned_to_tier1(self):
		books = [{
			"id": "af-queer",
			"title": "African Queer Story",
			"author": "A Author",
			"tags": ["LGBTQ"],
			"categories": [],
			"_blob": "african queer story lgbtq",
			"_iso2_sets": {"any": {"NG"}},
		}] + [
			{
				"id": f"us-queer-{i}",
				"title": f"US Queer {i}",
				"author": "U Author",
				"tags": ["queer"],
				"categories": [],
				"_blob": "queer romance us",
				"_iso2_sets": {"any": {"US"}},
			}
			for i in range(60)
		]
		available = [{"iso2": "NG", "name": "Nigeria"}, {"iso2": "US", "name": "United States"}]
		tier1, tier2, stats = _build_tiered_candidates(
			books, "queer books from Africa", None, available
		)
		tier1_ids = {b["id"] for b in tier1}
		self.assertIn("af-queer", tier1_ids)
		self.assertGreaterEqual(stats["tier1"], 1)

	def test_infer_africa_from_query(self):
		available = [{"iso2": "NG", "name": "Nigeria"}, {"iso2": "US", "name": "United States"}]
		geo = _infer_geo_iso2_from_query("queer books from Africa", available)
		self.assertIsNotNone(geo)
		self.assertIn("NG", geo)
		self.assertNotIn("US", geo)

	def test_tier2_includes_tags(self):
		books = [{
			"id": "x",
			"title": "Hidden Gem",
			"author": "Z",
			"tags": ["LGBTQ", "memoir"],
			"categories": ["fiction"],
			"_blob": "hidden gem",
			"_iso2_sets": {"any": {"KE"}},
			"_places": {"override": [{"iso2": "KE", "name": "Kenya"}]},
		}] + [
			{
				"id": f"filler-{i}",
				"title": f"Filler {i}",
				"author": "F",
				"tags": [],
				"categories": [],
				"_blob": f"filler {i}",
				"_iso2_sets": {"any": {"US"}},
			}
			for i in range(60)
		]
		_, tier2, _ = _build_tiered_candidates(books, "something obscure", None, [])
		by_id = {b["id"]: b for b in tier2}
		self.assertIn("x", by_id)
		self.assertEqual(by_id["x"].get("tags"), ["LGBTQ", "memoir"])


class FullCatalogRetryTests(unittest.TestCase):
	def test_retry_when_tiered_returns_no_recommendations(self):
		clean = {"recommendations": [], "assistant_markdown": "No match."}
		self.assertTrue(_should_retry_full_catalog({"assistant_markdown": "No match."}, clean, {"total": 200, "tier1": 50, "tier2": 150}))

	def test_no_retry_when_tiered_has_recommendations(self):
		clean = {"recommendations": [{"book_id": "x", "reason": "Good."}]}
		self.assertFalse(_should_retry_full_catalog({"recommendations": [{"book_id": "x"}]}, clean, {"total": 200, "tier1": 50, "tier2": 150}))

	def test_no_retry_when_catalog_fits_tier1(self):
		clean = {"recommendations": []}
		stats = {"total": 30, "tier1": 30, "tier2": 0}
		self.assertTrue(_catalog_already_fully_detailed(stats))
		self.assertFalse(_should_retry_full_catalog({}, clean, stats))

	def test_retry_on_parse_failure(self):
		clean = {"recommendations": []}
		self.assertTrue(_should_retry_full_catalog({}, clean, {"total": 200, "tier1": 50, "tier2": 150}))


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


class AtlasCatalogTests(unittest.TestCase):
	def test_book_record_for_client_shape(self):
		rec = _book_record_for_client({
			"id": "abc",
			"title": "Title",
			"author": "Author",
			"cover_url": "https://example.com/cover.jpg",
			"summary": "Summary",
			"bookshop_url": "https://bookshop.org/buy",
			"tags": ["Gay"],
			"read": True,
			"country_override": "US",
			"setting_country": ["FR"],
			"author_country": [],
			"author_origin": ["DE"],
		})
		self.assertEqual(rec["id"], "abc")
		self.assertEqual(rec["tags"], ["Gay"])
		self.assertTrue(rec["read"])
		self.assertEqual(rec["country_override"], "US")


if __name__ == "__main__":
	unittest.main()
