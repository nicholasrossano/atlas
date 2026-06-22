import assert from "node:assert";
import { coverUrlForDisplay } from "./cover-url.js";

const cases = [
	{
		name: "google zoom=0 becomes zoom=1",
		input: "https://books.google.com/books/content?id=dzTLDwAAQBAJ&printsec=frontcover&img=1&zoom=0&source=gbs_api",
		expected: "https://books.google.com/books/content?id=dzTLDwAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api",
	},
	{
		name: "google zoom=1 unchanged",
		input: "https://books.google.com/books/content?id=rvePDwAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api",
		expected: "https://books.google.com/books/content?id=rvePDwAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api",
	},
	{
		name: "open library large becomes medium",
		input: "https://covers.openlibrary.org/b/id/900528-L.jpg",
		expected: "https://covers.openlibrary.org/b/id/900528-M.jpg",
	},
	{
		name: "empty string",
		input: "",
		expected: "",
	},
	{
		name: "data url passthrough",
		input: "data:image/svg+xml;utf8,abc",
		expected: "data:image/svg+xml;utf8,abc",
	},
	{
		name: "unknown host unchanged",
		input: "https://example.com/cover.jpg",
		expected: "https://example.com/cover.jpg",
	},
];

let failed = 0;
for (const { name, input, expected } of cases) {
	try {
		assert.strictEqual(coverUrlForDisplay(input), expected);
		console.log(`ok ${name}`);
	} catch (err) {
		failed += 1;
		console.error(`FAIL ${name}:`, err.message);
	}
}

if (failed) process.exit(1);
