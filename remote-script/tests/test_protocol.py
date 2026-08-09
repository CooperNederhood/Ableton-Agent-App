import json
import struct
import sys
import unittest
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.protocol import (  # noqa: E402
    FrameDecodeError,
    FrameDecoder,
    encode_frame,
)


class FrameProtocolTests(unittest.TestCase):
    def test_round_trip(self):
        message = {"protocolVersion": 1, "kind": "request"}
        self.assertEqual(FrameDecoder().push(encode_frame(message)), [message])

    def test_fragmentation(self):
        message = {"hello": "world"}
        frame = encode_frame(message)
        decoder = FrameDecoder()
        self.assertEqual(decoder.push(frame[:2]), [])
        self.assertEqual(decoder.push(frame[2:7]), [])
        self.assertEqual(decoder.push(frame[7:]), [message])

    def test_concatenated_frames(self):
        first = {"id": 1}
        second = {"id": 2}
        self.assertEqual(
            FrameDecoder().push(encode_frame(first) + encode_frame(second)),
            [first, second],
        )

    def test_rejects_zero_length(self):
        with self.assertRaises(FrameDecodeError):
            FrameDecoder().push(struct.pack(">I", 0))

    def test_rejects_oversized_frame(self):
        with self.assertRaises(FrameDecodeError):
            FrameDecoder(max_frame_bytes=4).push(struct.pack(">I", 5))

    def test_rejects_invalid_json(self):
        payload = b"{"
        with self.assertRaises(FrameDecodeError):
            FrameDecoder().push(struct.pack(">I", len(payload)) + payload)

    def test_encoding_is_compact_json(self):
        frame = encode_frame({"b": 1, "a": 2})
        length = struct.unpack(">I", frame[:4])[0]
        self.assertEqual(length, len(frame[4:]))
        self.assertEqual(json.loads(frame[4:].decode("utf-8")), {"a": 2, "b": 1})


if __name__ == "__main__":
    unittest.main()
