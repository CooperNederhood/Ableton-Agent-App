"""Standalone protocol simulator for bridge integration tests and development."""

from __future__ import absolute_import, print_function, unicode_literals

import argparse
import json
import socket
import uuid

from AbletonAgent.protocol import FrameDecoder, encode_frame

PROTOCOL_VERSION = 2


class SimulatorState(object):
    def __init__(self):
        self.tempo = 120.0
        self.is_playing = False
        self.tracks = [
            {
                "reference": str(
                    uuid.uuid5(uuid.NAMESPACE_URL, "ableton-agent-simulator-drums")
                ),
                "name": "Drums",
                "kind": "midi",
                "color": 10,
                "isMuted": False,
                "isSoloed": False,
                "isArmed": False,
                "volume": 0.85,
                "pan": 0.0,
                "clips": [None, None],
                "arrangementClips": [],
            },
            {
                "reference": str(
                    uuid.uuid5(uuid.NAMESPACE_URL, "ableton-agent-simulator-bass")
                ),
                "name": "Bass",
                "kind": "midi",
                "color": None,
                "isMuted": False,
                "isSoloed": False,
                "isArmed": True,
                "volume": 0.75,
                "pan": -0.1,
                "clips": [None, None],
                "arrangementClips": [],
            },
        ]

    def session_tracks(self):
        return [
            dict(
                {"index": index},
                **{
                    key: value
                    for key, value in track.items()
                    if key not in ("clips", "arrangementClips")
                }
            )
            for index, track in enumerate(self.tracks)
        ]


def response(request, result):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "requestId": request["requestId"],
        "ok": True,
        "result": result,
        "warnings": [],
    }


def failure(request, code, message):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "requestId": request["requestId"],
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "retryable": False,
            "details": {},
        },
    }


def handle(request, token, state):
    if request.get("kind") != "request":
        return None
    command = request.get("command")
    params = request.get("params", {})
    if command == "system.hello":
        if params.get("authenticationToken") != token:
            return failure(
                request, "authentication_failed", "Invalid authentication token"
            )
        if PROTOCOL_VERSION not in params.get(
            "supportedProtocolVersions", []
        ):
            return failure(
                request,
                "protocol_version_unsupported",
                "No supported protocol version",
            )
        return response(
            request,
            {
                "selectedProtocolVersion": PROTOCOL_VERSION,
                "liveVersion": "12.1-simulator",
                "remoteScriptVersion": "0.2.0",
                "projectId": "simulated-project",
                "capabilities": {
                    "system.ping": True,
                    "session.inspect": True,
                    "transport.set_tempo": True,
                    "transport.set_playing": True,
                    "tracks.create": True,
                    "tracks.delete": True,
                    "tracks.rename": True,
                    "tracks.set_mixer": True,
                    "clips.create_midi": True,
                    "clips.replace_notes": True,
                    "arrangement.create_midi_clip": True,
                    "arrangement.inspect": True,
                    "arrangement.delete_clip": True,
                },
                "limits": {
                    "maxFrameBytes": 4 * 1024 * 1024,
                    "maxBatchItems": 128,
                },
            },
        )
    if command == "system.ping":
        return response(request, {"pong": True})
    if command == "session.inspect":
        return response(
            request,
            {
                "tempo": state.tempo,
                "timeSignature": {"numerator": 4, "denominator": 4},
                "isPlaying": state.is_playing,
                "trackCount": len(state.tracks),
                "tracks": state.session_tracks(),
            },
        )
    if command == "transport.set_tempo":
        tempo = params.get("tempo")
        if (
            isinstance(tempo, bool)
            or not isinstance(tempo, (int, float))
            or tempo < 20
            or tempo > 999
        ):
            return failure(
                request,
                "invalid_params",
                "tempo must be between 20 and 999 BPM",
            )
        before = state.tempo
        state.tempo = tempo
        return response(
            request,
            {
                "beforeTempo": before,
                "afterTempo": tempo,
                "verified": True,
            },
        )
    if command == "transport.set_playing":
        is_playing = params.get("isPlaying")
        if not isinstance(is_playing, bool):
            return failure(
                request,
                "invalid_params",
                "isPlaying must be a boolean",
            )
        before = state.is_playing
        state.is_playing = is_playing
        return response(
            request,
            {
                "beforeIsPlaying": before,
                "afterIsPlaying": is_playing,
                "verified": True,
            },
        )
    if command == "tracks.create":
        kind = params.get("kind")
        name = params.get("name")
        if kind not in ("midi", "audio"):
            return failure(request, "invalid_params", "kind must be midi or audio")
        before_count = len(state.tracks)
        track = {
            "reference": str(uuid.uuid4()),
            "name": name or ("MIDI" if kind == "midi" else "Audio"),
            "kind": kind,
            "color": None,
            "isMuted": False,
            "isSoloed": False,
            "isArmed": False,
            "volume": 0.85,
            "pan": 0.0,
            "clips": [None, None],
            "arrangementClips": [],
        }
        state.tracks.append(track)
        return response(
            request,
            {
                "beforeTrackCount": before_count,
                "afterTrackCount": len(state.tracks),
                "track": {
                    "index": before_count,
                    "reference": track["reference"],
                    "name": track["name"],
                    "kind": kind,
                },
                "verified": True,
            },
        )
    if command == "tracks.delete":
        index = params.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            return failure(request, "invalid_params", "index must be non-negative")
        if len(state.tracks) <= 1:
            return failure(request, "conflict", "Cannot delete the last track")
        if index >= len(state.tracks):
            return failure(request, "not_found", "Track index is out of range")
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
            or track["kind"] != params.get("expectedKind")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before deletion",
            )
        before_count = len(state.tracks)
        del state.tracks[index]
        return response(
            request,
            {
                "beforeTrackCount": before_count,
                "afterTrackCount": len(state.tracks),
                "track": {
                    "index": index,
                    "reference": track["reference"],
                    "name": track["name"],
                    "kind": track["kind"],
                },
                "verified": True,
            },
        )
    if command in ("tracks.rename", "tracks.set_mixer"):
        index = params.get("index")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(state.tracks)
        ):
            return failure(request, "not_found", "Track index is out of range")
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before mutation",
            )
        if command == "tracks.rename":
            name = params.get("name")
            if not isinstance(name, str) or not name.strip():
                return failure(request, "invalid_params", "name is required")
            before = track["name"]
            track["name"] = name.strip()
            return response(
                request,
                {
                    "reference": track["reference"],
                    "index": index,
                    "beforeName": before,
                    "afterName": track["name"],
                    "verified": True,
                },
            )
        before = {
            key: track[key]
            for key in ("isMuted", "isSoloed", "isArmed", "volume", "pan")
        }
        updates = {
            key: params[key]
            for key in ("isMuted", "isSoloed", "isArmed", "volume", "pan")
            if key in params
        }
        if not updates:
            return failure(
                request,
                "invalid_params",
                "At least one mixer property is required",
            )
        track.update(updates)
        after = {
            key: track[key]
            for key in ("isMuted", "isSoloed", "isArmed", "volume", "pan")
        }
        return response(
            request,
            {
                "reference": track["reference"],
                "index": index,
                "before": before,
                "after": after,
                "verified": True,
            },
        )
    if command in ("clips.create_midi", "clips.replace_notes"):
        index = params.get("index")
        scene_index = params.get("sceneIndex")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(state.tracks)
            or isinstance(scene_index, bool)
            or not isinstance(scene_index, int)
            or scene_index < 0
            or scene_index >= 2
        ):
            return failure(request, "not_found", "Track or scene is out of range")
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before mutation",
            )
        if command == "clips.create_midi":
            if track["kind"] != "midi":
                return failure(
                    request,
                    "unsupported_capability",
                    "MIDI clips require a MIDI track",
                )
            if track["clips"][scene_index] is not None:
                return failure(request, "conflict", "Clip slot is occupied")
            clip = {
                "reference": str(uuid.uuid4()),
                "name": params.get("name") or "",
                "kind": "midi",
                "length": params.get("length"),
                "notes": [],
            }
            track["clips"][scene_index] = clip
            return response(
                request,
                {
                    "clip": {
                        "reference": clip["reference"],
                        "trackReference": track["reference"],
                        "trackIndex": index,
                        "sceneIndex": scene_index,
                        "name": clip["name"],
                        "length": clip["length"],
                        "noteCount": 0,
                    },
                    "verified": True,
                },
            )
        clip = track["clips"][scene_index]
        if clip is None:
            return failure(request, "not_found", "Clip slot is empty")
        if clip["reference"] != params.get("expectedClipReference"):
            return failure(
                request,
                "stale_reference",
                "Clip identity changed before note replacement",
            )
        before_count = len(clip["notes"])
        allow_expression_loss = params.get("allowPerNoteExpressionLoss")
        if not isinstance(allow_expression_loss, bool):
            return failure(
                request,
                "invalid_params",
                "allowPerNoteExpressionLoss must be a boolean",
            )
        if before_count and not allow_expression_loss:
            return failure(
                request,
                "conflict",
                "Replacing notes may discard per-note expression data",
            )
        clip["notes"] = params.get("notes", [])
        return response(
            request,
            {
                "clip": {
                    "reference": clip["reference"],
                    "trackReference": track["reference"],
                    "trackIndex": index,
                    "sceneIndex": scene_index,
                    "name": clip["name"],
                    "length": clip["length"],
                    "noteCount": len(clip["notes"]),
                },
                "beforeNoteCount": before_count,
                "afterNoteCount": len(clip["notes"]),
                "verified": True,
            },
        )
    if command == "arrangement.create_midi_clip":
        index = params.get("index")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(state.tracks)
        ):
            return failure(request, "not_found", "Track index is out of range")
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before mutation",
            )
        if track["kind"] != "midi":
            return failure(
                request,
                "unsupported_capability",
                "Arrangement MIDI clips require a MIDI track",
            )
        start_time = params.get("startTime")
        length = params.get("length")
        end_time = start_time + length
        if any(
            start_time < existing["endTime"]
            and end_time > existing["startTime"]
            for existing in track["arrangementClips"]
        ):
            return failure(
                request,
                "conflict",
                "Arrangement range overlaps an existing clip",
            )
        clip = {
            "reference": str(uuid.uuid4()),
            "trackReference": track["reference"],
            "trackIndex": index,
            "name": params.get("name") or "",
            "kind": "midi",
            "startTime": start_time,
            "endTime": end_time,
            "length": length,
            "noteCount": 0,
        }
        track["arrangementClips"].append(clip)
        return response(request, {"clip": clip, "verified": True})
    if command == "arrangement.inspect":
        clips = sorted(
            [
                clip
                for track in state.tracks
                for clip in track["arrangementClips"]
            ],
            key=lambda clip: (clip["startTime"], clip["trackIndex"]),
        )
        offset = params.get("offset", 0)
        limit = params.get("limit", 100)
        return response(
            request,
            {
                "clips": clips[offset : offset + limit],
                "total": len(clips),
                "offset": offset,
                "limit": limit,
            },
        )
    if command == "arrangement.delete_clip":
        index = params.get("index")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(state.tracks)
        ):
            return failure(request, "not_found", "Track index is out of range")
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before mutation",
            )
        target = next(
            (
                clip
                for clip in track["arrangementClips"]
                if clip["reference"] == params.get("expectedClipReference")
            ),
            None,
        )
        if target is None or abs(
            target["startTime"] - params.get("expectedStartTime")
        ) >= 0.000001:
            return failure(
                request,
                "stale_reference",
                "Arrangement clip changed before deletion",
            )
        before_count = len(track["arrangementClips"])
        track["arrangementClips"].remove(target)
        return response(
            request,
            {
                "clip": target,
                "beforeClipCount": before_count,
                "afterClipCount": len(track["arrangementClips"]),
                "verified": True,
            },
        )
    return failure(request, "unknown_command", "Unknown command: {0}".format(command))


def serve(host, port, token):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(1)
    print(
        json.dumps({"host": host, "port": server.getsockname()[1]}),
        flush=True,
    )
    connection, _address = server.accept()
    decoder = FrameDecoder()
    state = SimulatorState()
    try:
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            for request in decoder.push(chunk):
                result = handle(request, token, state)
                if result is not None:
                    connection.sendall(encode_frame(result))
    finally:
        connection.close()
        server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    serve(args.host, args.port, args.token)


if __name__ == "__main__":
    main()
