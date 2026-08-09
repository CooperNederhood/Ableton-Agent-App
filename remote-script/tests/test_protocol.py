import json
import random
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

    def test_deterministic_random_fragmentation_and_concatenation(self):
        messages = [{"id": index} for index in range(25)]
        data = b"".join(encode_frame(message) for message in messages)
        generator = random.Random(0x5EED1234)
        decoder = FrameDecoder()
        decoded = []
        offset = 0
        while offset < len(data):
            size = generator.randint(1, 37)
            decoded.extend(decoder.push(data[offset : offset + size]))
            offset += size
        decoder.finish()
        self.assertEqual(decoded, messages)

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

    def test_rejects_invalid_utf8(self):
        payload = b"\xc3\x28"
        with self.assertRaises(FrameDecodeError):
            FrameDecoder().push(struct.pack(">I", len(payload)) + payload)

    def test_rejects_truncated_frame_when_stream_finishes(self):
        decoder = FrameDecoder()
        decoder.push(encode_frame({"id": 1})[:6])
        with self.assertRaisesRegex(FrameDecodeError, "truncated frame"):
            decoder.finish()
        self.assertEqual(decoder.buffered_bytes, 0)

    def test_encoding_is_compact_json(self):
        frame = encode_frame({"b": 1, "a": 2})
        length = struct.unpack(">I", frame[:4])[0]
        self.assertEqual(length, len(frame[4:]))
        self.assertEqual(json.loads(frame[4:].decode("utf-8")), {"a": 2, "b": 1})


if __name__ == "__main__":
    unittest.main()
