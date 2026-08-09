"""Stable protocol errors used by Remote Script commands."""

from __future__ import absolute_import, unicode_literals


class ProtocolFailure(Exception):
    def __init__(self, code, message, retryable=False, details=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or {}
