"""WhisperLink OSS — WSGI entry point for the Flask app.
Author: Antonio Brandao
License: MIT

gunicorn -w 2 -b 127.0.0.1:5057 wsgi:application  (APPLICATION_ROOT=/whisperlink)
"""
from chirp_oss import create_app

application = app = create_app()
