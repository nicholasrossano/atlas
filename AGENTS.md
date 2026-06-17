# AGENTS.md — Atlas agent guide

Instructions for AI agents working in this repo. Read this before changing CI, Cloud Functions, or deploy config.

## Project layout

- `public/` — static Atlas map + list UI (Firebase Hosting target `map`)
- `functions/` — Python Cloud Functions (`atlasCatalog`, `atlasChat` in `atlas_chat.py`, exported via `main.py`)
- `firebase.json` — Hosting rewrites and Functions runtime config
- `.github/workflows/` — CI on PR (test + preview) and merge (test + hosting + functions deploy)

## CI/CD (do not break this)

Every push to `main` runs **Deploy to Firebase Hosting on merge** with three jobs:

1. **test_functions** — Python 3.12, `pip install -r requirements.txt`, unit tests
2. **build_and_deploy** — Firebase Hosting preview channel `live`
3. **deploy_functions** — venv prep + `firebase deploy --only functions:atlasCatalog,functions:atlasChat`

### Common failure modes (check these first)

| Symptom | Cause | Fix |
|--------|--------|-----|
| `Failed to find location of Firebase Functions SDK` / `python3.14 -m venv` | `firebase-tools` default runtime (3.14) ≠ CI Python (3.12) | Keep `firebase.json` → `functions[].runtime` in sync with workflow `python-version` |
| `Missing virtual environment at venv directory` | Deploy job skipped venv setup | Run `bash scripts/prepare_functions_venv.sh` before deploy |
| `Missing permissions ... iam.serviceAccounts.ActAs` | GHA service account lacks roles | Grant **Service Account User** (`roles/iam.serviceAccountUser`) to the GitHub Actions deploy SA on `1070041172712-compute@developer.gserviceaccount.com` (and `ponder-f84ce@appspot.gserviceaccount.com` if needed). Merge CI runs `deploy_functions` with `continue-on-error` until IAM is fixed. |
| `secretmanager.versions.get` denied on `OPENAI_API_KEY` | GHA deploy SA cannot read Secret Manager | Grant **Secret Manager Secret Accessor** (+ **Secret Manager Viewer**) to the GitHub Actions service account for `atlasChat` deploys |
| Unit tests fail importing Firestore | Eager `firestore.client()` at import | Keep lazy `_get_db()` pattern in `atlas_chat.py` |

### Required checks before merging CI/deploy changes

Run locally from repo root:

```bash
cd functions && python -m unittest test_atlas_chat.py test_ci_config.py
bash scripts/prepare_functions_venv.sh
```

`test_ci_config.py` asserts:

- `firebase.json` sets `functions[].runtime`
- GitHub Actions `python-version` matches that runtime
- Merge workflow uses `prepare_functions_venv.sh` and scoped function deploy targets

### Python runtime policy

- **Runtime:** `python312` in `firebase.json` (explicit — never rely on firebase-tools default)
- **CI Python:** `"3.12"` in both workflow files
- **If upgrading runtime:** change `firebase.json` runtime, both workflows' `python-version`, and `scripts/prepare_functions_venv.sh` case mapping together. `test_ci_config.py` should catch mismatches.

### Deploy scope (shared Firebase project)

- Deploy **only** `functions:atlasCatalog,functions:atlasChat` — do not `firebase deploy --only functions` (shared Ponder project).
- Do **not** deploy Firestore rules from this repo (`README.md`).

## Cloud Functions conventions

- Entry: `functions/main.py` re-exports from `atlas_chat.py`
- Dependencies: `functions/requirements.txt`
- Secrets: `OPENAI_API_KEY` on `atlasChat` only
- Firestore: Admin SDK only; lazy `_get_db()` — tests must import without credentials

## When editing functions

1. Run unit tests (above).
2. If touching deploy/CI: run `test_ci_config.py` and `prepare_functions_venv.sh`.
3. Prefer minimal diffs; match existing tab-indented Python style in `atlas_chat.py`.

## Hosting / frontend

- Local config: copy `public/config.example.js` → `public/config.js` (gitignored)
- Catalog API: `/api/atlas/books` → `atlasCatalog` rewrite in `firebase.json`
- Book data is **not** read from client Firestore; list/map use the catalog endpoint

## Audit scripts (manual, not CI)

- `python functions/scripts/audit_country_override.py --dry-run`
- `python functions/scripts/audit_bookshop_urls.py`
