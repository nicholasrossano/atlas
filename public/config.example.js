// Production runtime config (deployed with Firebase Hosting).
// Copy to public/config.js for local overrides, or edit config.example.js when forking.
window.ATLAS_CONFIG = {
	maptiler: {
		apiKey: "YOUR_MAPTILER_KEY",
		styleId: "YOUR_STYLE_ID",
		apiRoot: "https://api.maptiler.com"
	},
	atlas: {
		chatEndpoint: "https://us-central1-YOUR_PROJECT.cloudfunctions.net/atlasChat",
		catalogEndpoint: "https://us-central1-YOUR_PROJECT.cloudfunctions.net/atlasCatalog"
	}
};
