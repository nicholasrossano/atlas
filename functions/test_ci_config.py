import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIREBASE_JSON = ROOT / "firebase.json"
WORKFLOW_FILES = [
	ROOT / ".github/workflows/firebase-hosting-merge.yml",
	ROOT / ".github/workflows/firebase-hosting-pull-request.yml",
]
PREPARE_VENV_SCRIPT = ROOT / "scripts/prepare_functions_venv.sh"

RUNTIME_TO_PYTHON = {
	"python310": "3.10",
	"python311": "3.11",
	"python312": "3.12",
	"python313": "3.13",
	"python314": "3.14",
}


class CIConfigTests(unittest.TestCase):
	def test_firebase_functions_runtime_is_set(self):
		data = json.loads(FIREBASE_JSON.read_text())
		runtime = data["functions"][0].get("runtime")
		self.assertIsNotNone(runtime, "firebase.json must set functions[].runtime")
		self.assertIn(runtime, RUNTIME_TO_PYTHON)

	def test_workflows_use_matching_python_version(self):
		data = json.loads(FIREBASE_JSON.read_text())
		runtime = data["functions"][0]["runtime"]
		expected = RUNTIME_TO_PYTHON[runtime]
		for workflow in WORKFLOW_FILES:
			content = workflow.read_text()
			self.assertIn(
				f'python-version: "{expected}"',
				content,
				f"{workflow.name} must use python-version {expected} to match firebase runtime {runtime}",
			)

	def test_merge_workflow_prepares_functions_venv(self):
		content = (ROOT / ".github/workflows/firebase-hosting-merge.yml").read_text()
		self.assertIn("scripts/prepare_functions_venv.sh", content)
		self.assertIn("functions:atlasCatalog,functions:atlasChat", content)

	def test_prepare_venv_script_exists(self):
		self.assertTrue(PREPARE_VENV_SCRIPT.is_file())
		content = PREPARE_VENV_SCRIPT.read_text()
		self.assertIn("firebase.json", content)
		for runtime in RUNTIME_TO_PYTHON:
			self.assertIn(runtime, content)

	def test_hosting_runtime_config_is_deployable(self):
		config_path = ROOT / "public/config.js"
		self.assertTrue(config_path.is_file(), "public/config.js must be committed for Hosting deploys")
		content = config_path.read_text()
		self.assertIn("maptiler", content)
		self.assertIn("apiKey", content)
		self.assertIn("styleId", content)

	def test_workflows_run_frontend_cover_url_tests(self):
		for workflow in WORKFLOW_FILES:
			content = workflow.read_text()
			self.assertIn("test_cover_url.js", content, f"{workflow.name} must run cover URL tests")


if __name__ == "__main__":
	unittest.main()
