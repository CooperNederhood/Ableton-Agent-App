"""Dependency-free framing for communication with the Ableton Agent app."""

from __future__ import absolute_import, print_function, unicode_literals

import json
import struct

FRAME_HEADER_BYTES = 4
DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024


class FrameDecodeError(ValueError):
    """Raised when a protocol frame is invalid."""


def encode_frame(message):
    payload = json.dumps(
        message, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    if not payload:
        raise ValueError("Payload cannot be empty")
    return struct.pack(">I", len(payload)) + payload


class FrameDecoder(object):
    def __init__(self, max_frame_bytes=DEFAULT_MAX_FRAME_BYTES):
        if max_frame_bytes <= 0:
            raise ValueError("max_frame_bytes must be positive")
        self._max_frame_bytes = max_frame_bytes
        self._buffer = b""

    @property
    def buffered_bytes(self):
        return len(self._buffer)

    def reset(self):
        self._buffer = b""

    def finish(self):
        if not self._buffer:
            return
        buffered_bytes = len(self._buffer)
        self.reset()
        raise FrameDecodeError(
            "Stream ended with {0} buffered byte(s) from a truncated frame".format(
                buffered_bytes
            )
        )

    def push(self, chunk):
        if not chunk:
            return []
        self._buffer += chunk
        messages = []
        offset = 0

        while len(self._buffer) - offset >= FRAME_HEADER_BYTES:
            length = struct.unpack(
                ">I", self._buffer[offset : offset + FRAME_HEADER_BYTES]
            )[0]
            if length == 0:
                self.reset()
                raise FrameDecodeError("Zero-length frames are not allowed")
            if length > self._max_frame_bytes:
                self.reset()
                raise FrameDecodeError(
                    "Frame length {0} exceeds maximum {1}".format(
                        length, self._max_frame_bytes
                    )
                )
            frame_end = offset + FRAME_HEADER_BYTES + length
            if len(self._buffer) < frame_end:
                break
            payload = self._buffer[
                offset + FRAME_HEADER_BYTES : frame_end
            ]
            try:
                messages.append(json.loads(payload.decode("utf-8")))
            except (UnicodeDecodeError, ValueError) as exc:
                self.reset()
                raise FrameDecodeError(
                    "Invalid frame payload: {0}".format(exc)
                )
            offset = frame_end

        self._buffer = self._buffer[offset:]
        return messages
