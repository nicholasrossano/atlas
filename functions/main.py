import logging

from firebase_functions import https_fn
from firebase_admin import initialize_app, get_app

try:
	get_app()
except ValueError:
	initialize_app()

logger = logging.getLogger()
logger.setLevel(logging.INFO)

from atlas_chat import atlasChat  # noqa: E402,F401
