"""Per-installation authentication token storage."""

from __future__ import absolute_import, unicode_literals

import binascii
import os

TOKEN_FILENAME = ".ableton-agent-token"


def load_or_create_token(directory):
    path = os.path.join(directory, TOKEN_FILENAME)
    try:
        with open(path, "r") as token_file:
            token = token_file.read().strip()
        if len(token) >= 32:
            return token
    except IOError:
        pass

    token = binascii.hexlify(os.urandom(32)).decode("ascii")
    temporary = path + ".tmp"
    with open(temporary, "w") as token_file:
        token_file.write(token)
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    replace = getattr(os, "replace", os.rename)
    replace(temporary, path)
    return token
