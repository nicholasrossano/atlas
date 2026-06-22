/** Downscale known cover CDN URLs for thumbnail display (list/map/chat). */
export function coverUrlForDisplay(url) {
	const trimmed = String(url || "").trim();
	if (!trimmed || trimmed.startsWith("data:")) return trimmed;

	let out = trimmed;
	if (out.includes("books.google.com/books/content")) {
		out = out.replace(/([?&]zoom=)0(?=&|$)/, "$11");
	}
	if (out.includes("covers.openlibrary.org")) {
		out = out.replace(/-L\.jpg/i, "-M.jpg");
	}
	return out;
}
