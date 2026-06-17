// Copy to public/config.js and fill in your values (config.js is gitignored).
window.ATLAS_CONFIG = {
	firebase: {
		apiKey: "YOUR_FIREBASE_API_KEY",
		authDomain: "YOUR_PROJECT.firebaseapp.com",
		projectId: "YOUR_PROJECT_ID",
		storageBucket: "YOUR_PROJECT.appspot.com",
		messagingSenderId: "YOUR_SENDER_ID",
		appId: "YOUR_APP_ID"
	},
	maptiler: {
		apiKey: "YOUR_MAPTILER_KEY",
		styleId: "YOUR_STYLE_ID",
		apiRoot: "https://api.maptiler.com"
	},
	atlas: {
		chatEndpoint: "https://us-central1-YOUR_PROJECT.cloudfunctions.net/atlasChat"
	}
};
