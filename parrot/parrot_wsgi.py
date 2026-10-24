"""Stable cPanel/Passenger startup target for the PARROT WSGI service."""

import os
import sys


APP_ROOT = os.path.dirname(os.path.abspath(__file__))
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

from parrot_app import application


__all__ = ["application"]
