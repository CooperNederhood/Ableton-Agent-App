"""Standalone protocol simulator for bridge integration tests and development."""

from __future__ import absolute_import, print_function, unicode_literals

import argparse
import json
import math
import socket
import uuid
from collections import deque

from AbletonAgent.protocol import FrameDecoder, encode_frame

from AbletonAgent.version import PROTOCOL_VERSION


class SimulatorState(object):
    def __init__(self):
        self.tempo = 120.0
        self.is_playing = False
        self.loop_enabled = False
        self.loop_start = 0.0
        self.loop_length = 16.0
        self.cue_points = [
            {
                "reference": str(
                    uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        "ableton-agent-simulator-cue-intro",
                    )
                ),
                "name": "Intro",
                "time": 0.0,
            },
            {
                "reference": str(
                    uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        "ableton-agent-simulator-cue-verse",
                    )
                ),
                "name": "Verse",
                "time": 16.0,
            },
        ]
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
                "playingSceneIndex": None,
                "devices": [self.simulated_device("Drum Rack")],
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
                "playingSceneIndex": None,
                "devices": [self.simulated_device("Operator")],
            },
        ]
        self.browser_roots = self.create_browser_roots()

    def browser_item(
        self, name, uri, children=None, loadable=False, device=False, source=""
    ):
        return {
            "reference": str(uuid.uuid5(uuid.NAMESPACE_URL, uri)),
            "name": name,
            "uri": uri,
            "isFolder": children is not None,
            "isLoadable": loadable,
            "isDevice": device,
            "source": source,
            "children": list(children or []),
        }

    def create_browser_roots(self):
        operator = self.browser_item(
            "Operator",
            "ableton://instruments/operator",
            loadable=True,
            device=True,
            source="instrument",
        )
        analog = self.browser_item(
            "Analog",
            "ableton://instruments/analog",
            loadable=True,
            device=True,
            source="instrument",
        )
        synths = self.browser_item(
            "Synths",
            "ableton://instruments/synths",
            [operator, analog],
        )
        roots = {
            "instruments": self.browser_item(
                "Instruments", "ableton://instruments", [synths]
            ),
            "audio_effects": self.browser_item(
                "Audio Effects",
                "ableton://audio-effects",
                [
                    self.browser_item(
                        "Echo",
                        "ableton://audio-effects/echo",
                        loadable=True,
                        device=True,
                        source="audio_effect",
                    )
                ],
            ),
            "midi_effects": self.browser_item(
                "MIDI Effects",
                "ableton://midi-effects",
                [
                    self.browser_item(
                        "Arpeggiator",
                        "ableton://midi-effects/arpeggiator",
                        loadable=True,
                        device=True,
                        source="midi_effect",
                    )
                ],
            ),
        }
        for key, name in (
            ("sounds", "Sounds"),
            ("drums", "Drums"),
            ("max_for_live", "Max for Live"),
            ("plugins", "Plug-ins"),
            ("clips", "Clips"),
            ("samples", "Samples"),
            ("packs", "Packs"),
            ("user_library", "User Library"),
            ("current_project", "Current Project"),
        ):
            roots[key] = self.browser_item(
                name, "ableton://{0}".format(key), []
            )
        return roots

    def browser_item_summary(self, root, path, item):
        source = item["source"].strip().casefold().replace(" ", "_")
        uri = item["uri"].strip().casefold()
        return {
            "reference": item["reference"],
            "root": root,
            "path": path,
            "name": item["name"],
            "uri": item["uri"],
            "isFolder": item["isFolder"],
            "isLoadable": item["isLoadable"],
            "isDevice": item["isDevice"],
            "source": item["source"],
            "isBuiltInDevice": item["isDevice"]
            and root in ("instruments", "audio_effects", "midi_effects")
            and not any(
                marker in source
                for marker in ("user", "project", "plugin", "vst", "audio_unit")
            )
            and uri.startswith("ableton://")
            and not any(
                marker in uri
                for marker in ("user", "plugin", "vst", "audio_unit", "external")
            ),
        }

    def resolve_browser_item(self, root, path):
        item = self.browser_roots.get(root)
        if item is None:
            return None
        for segment in path:
            index = segment.get("index")
            if (
                not item["isFolder"]
                or not isinstance(index, int)
                or index < 0
                or index >= len(item["children"])
            ):
                return None
            item = item["children"][index]
            if item["name"] != segment.get("name"):
                return None
        return item

    def browser_load_state(self, track):
        occupied = [
            index
            for index, clip in enumerate(track["clips"])
            if clip is not None
        ]
        return {
            "deviceCount": len(track["devices"]),
            "deviceReferences": [
                device["reference"] for device in track["devices"][:128]
            ],
            "deviceNames": [
                device["name"] for device in track["devices"][:128]
            ],
            "devicesTruncated": len(track["devices"]) > 128,
            "sessionClipCount": len(occupied),
            "occupiedSessionSlots": occupied[:128],
            "clipsTruncated": len(occupied) > 128,
        }

    def simulated_device(self, name):
        device = self.simulated_leaf_device(name)
        if name == "Drum Rack":
            kick_chain = self.simulated_chain(
                "Kick",
                [self.simulated_leaf_device("Simpler")],
            )
            snare_chain = self.simulated_chain(
                "Snare",
                [self.simulated_leaf_device("Simpler")],
            )
            device["canHaveChains"] = True
            device["canHaveDrumPads"] = True
            device["chains"] = [kick_chain, snare_chain]
            device["drumPads"] = [
                self.simulated_pad(
                    note,
                    "Kick" if note == 36 else "Snare" if note == 38 else "",
                    [kick_chain]
                    if note == 36
                    else [snare_chain]
                    if note == 38
                    else [],
                )
                for note in range(128)
            ]
        return device

    def simulated_leaf_device(self, name):
        reference = str(uuid.uuid4())
        return {
            "reference": reference,
            "name": name,
            "className": name.replace(" ", ""),
            "classDisplayName": name,
            "parameters": [
                {
                    "reference": str(uuid.uuid4()),
                    "name": "Device On",
                    "value": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "isQuantized": True,
                    "isEnabled": True,
                    "isWritable": True,
                    "valueItemCount": 2,
                },
                {
                    "reference": str(uuid.uuid4()),
                    "name": "Dry/Wet",
                    "value": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "isQuantized": False,
                    "isEnabled": True,
                    "isWritable": True,
                    "valueItemCount": 0,
                },
                {
                    "reference": str(uuid.uuid4()),
                    "name": "Mode",
                    "value": 0.0,
                    "min": 0.0,
                    "max": 2.0,
                    "isQuantized": True,
                    "isEnabled": True,
                    "isWritable": True,
                    "valueItemCount": 3,
                },
            ],
            "canHaveChains": False,
            "canHaveDrumPads": False,
            "chains": [],
            "drumPads": [],
        }

    def simulated_chain(self, name, devices):
        return {
            "reference": str(uuid.uuid4()),
            "name": name,
            "color": None,
            "devices": devices,
        }

    def simulated_pad(self, note, name, chains):
        return {
            "reference": str(uuid.uuid4()),
            "note": note,
            "name": name,
            "mute": False,
            "solo": False,
            "chains": chains,
        }

    def session_tracks(self):
        return [
            dict(
                {"index": index},
                **{
                    key: value
                    for key, value in track.items()
                    if key
                    not in (
                        "clips",
                        "arrangementClips",
                        "playingSceneIndex",
                        "devices",
                    )
                }
            )
            for index, track in enumerate(self.tracks)
        ]

    def session_clip_summary(self, track_index, scene_index, clip):
        track = self.tracks[track_index]
        return {
            "reference": clip["reference"],
            "trackReference": track["reference"],
            "trackIndex": track_index,
            "sceneIndex": scene_index,
            "name": clip["name"],
            "kind": clip["kind"],
            "length": clip["length"],
            "noteCount": (
                len(clip.get("notes", []))
                if clip["kind"] == "midi"
                else None
            ),
            "muted": clip.get("muted"),
            "looping": clip.get("looping"),
            "isPlaying": clip.get("isPlaying", False),
            "isTriggered": clip.get("isTriggered", False),
        }

    def session_clips(self):
        return [
            self.session_clip_summary(track_index, scene_index, clip)
            for track_index, track in enumerate(self.tracks)
            for scene_index, clip in enumerate(track["clips"])
            if clip is not None
        ]

    def device_summary(self, track_index, device_index, device):
        track = self.tracks[track_index]
        enabled = None
        if (
            device["parameters"]
            and device["parameters"][0]["name"] == "Device On"
        ):
            enabled = device["parameters"][0]["value"] >= 0.5
        return {
            "reference": device["reference"],
            "trackReference": track["reference"],
            "trackIndex": track_index,
            "index": device_index,
            "name": device["name"],
            "className": device["className"],
            "classDisplayName": device["classDisplayName"],
            "enabled": enabled,
            "parameterCount": len(device["parameters"]),
            "canHaveChains": device["canHaveChains"],
            "canHaveDrumPads": device["canHaveDrumPads"],
        }

    def chain_summary(self, rack, index, chain):
        return {
            "reference": chain["reference"],
            "rackDeviceReference": rack["reference"],
            "index": index,
            "name": chain["name"],
            "color": chain["color"],
            "deviceCount": len(chain["devices"]),
        }

    def pad_summary(self, rack, index, pad):
        return {
            "reference": pad["reference"],
            "rackDeviceReference": rack["reference"],
            "index": index,
            "note": pad["note"],
            "name": pad["name"],
            "mute": pad["mute"],
            "solo": pad["solo"],
            "chainCount": len(pad["chains"]),
        }

    def pad_chain_summary(self, rack, pad, pad_index, index, chain):
        summary = self.chain_summary(rack, index, chain)
        summary.update(
            {
                "drumPadReference": pad["reference"],
                "drumPadIndex": pad_index,
            }
        )
        return summary

    def chain_device_summary(self, chain, index, device):
        return {
            "reference": device["reference"],
            "chainReference": chain["reference"],
            "index": index,
            "name": device["name"],
            "className": device["className"],
            "classDisplayName": device["classDisplayName"],
            "enabled": (
                device["parameters"][0]["value"] >= 0.5
                if device["parameters"]
                and device["parameters"][0]["name"] == "Device On"
                else None
            ),
            "parameterCount": len(device["parameters"]),
            "canHaveChains": device["canHaveChains"],
            "canHaveDrumPads": device["canHaveDrumPads"],
        }

    def parameter_summary(self, device, index, parameter):
        span = parameter["max"] - parameter["min"]
        normalized = (
            0.0
            if span == 0
            else (parameter["value"] - parameter["min"]) / span
        )
        return {
            "reference": parameter["reference"],
            "deviceReference": device["reference"],
            "index": index,
            "name": parameter["name"],
            "value": parameter["value"],
            "normalizedValue": min(1.0, max(0.0, normalized)),
            "min": parameter["min"],
            "max": parameter["max"],
            "isQuantized": parameter["isQuantized"],
            "isEnabled": parameter["isEnabled"],
            "valueItemCount": parameter["valueItemCount"],
        }


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
                "remoteScriptVersion": "0.4.0",
                "projectId": "simulated-project",
                "capabilities": {
                    "system.ping": True,
                    "session.inspect": True,
                    "transport.set_tempo": True,
                    "transport.set_playing": True,
                    "transport.inspect_arrangement": True,
                    "transport.set_arrangement_loop": True,
                    "transport.create_cue_point": True,
                    "transport.delete_cue_point": True,
                    "tracks.create": True,
                    "tracks.delete": True,
                    "tracks.rename": True,
                    "tracks.set_mixer": True,
                    "devices.inspect": True,
                    "devices.inspect_parameters": True,
                    "devices.inspect_rack_chains": True,
                    "devices.inspect_rack_chain_devices": True,
                    "devices.inspect_drum_rack_pads": True,
                    "devices.inspect_drum_pad_chains": True,
                    "devices.inspect_drum_pad_chain_devices": True,
                    "devices.set_enabled": True,
                    "devices.set_parameter": True,
                    "browser.inspect_roots": True,
                    "browser.inspect_children": True,
                    "browser.search": True,
                    "browser.load_item": True,
                    "clips.create_midi": True,
                    "clips.replace_notes": True,
                    "clips.launch": True,
                    "clips.duplicate": True,
                    "clips.delete": True,
                    "clips.set_properties": True,
                    "arrangement.create_midi_clip": True,
                    "arrangement.inspect": True,
                    "arrangement.delete_clip": True,
                    "arrangement.replace_notes": True,
                    "arrangement.duplicate_clip": True,
                    "arrangement.set_clip_properties": True,
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
                "clips": state.session_clips(),
            },
        )
    if command == "browser.inspect_roots":
        if params:
            return failure(
                request,
                "invalid_params",
                "Command does not accept parameters",
            )
        root_order = (
            "sounds",
            "drums",
            "instruments",
            "audio_effects",
            "midi_effects",
            "max_for_live",
            "plugins",
            "clips",
            "samples",
            "packs",
            "user_library",
            "current_project",
        )
        return response(
            request,
            {
                "roots": [
                    state.browser_item_summary(
                        root, [], state.browser_roots[root]
                    )
                    for root in root_order
                ],
                "cacheLimit": 512,
            },
        )
    if command in ("browser.inspect_children", "browser.load_item"):
        root = params.get("expectedItemRoot")
        path = params.get("expectedItemPath")
        item = (
            state.resolve_browser_item(root, path)
            if isinstance(path, list)
            else None
        )
        if item is None:
            return failure(
                request,
                "stale_reference",
                "Browser item path changed",
            )
        if (
            item["reference"] != params.get("expectedItemReference")
            or item["name"] != params.get("expectedItemName")
            or item["uri"] != params.get("expectedItemUri")
        ):
            return failure(
                request,
                "stale_reference",
                "Browser item identity changed",
            )
        summary = state.browser_item_summary(root, path, item)
        if command == "browser.inspect_children":
            if not item["isFolder"]:
                return failure(
                    request,
                    "conflict",
                    "The targeted browser item is not a folder",
                )
            offset = params.get("offset", 0)
            limit = params.get("limit", 32)
            if (
                isinstance(offset, bool)
                or not isinstance(offset, int)
                or offset < 0
                or isinstance(limit, bool)
                or not isinstance(limit, int)
                or limit < 1
                or limit > 64
            ):
                return failure(
                    request,
                    "invalid_params",
                    "offset and limit must describe a bounded browser page",
                )
            return response(
                request,
                {
                    "parent": summary,
                    "items": [
                        state.browser_item_summary(
                            root,
                            path
                            + [{"index": index, "name": child["name"]}],
                            child,
                        )
                        for index, child in enumerate(
                            item["children"][offset : offset + limit],
                            start=offset,
                        )
                    ],
                    "total": len(item["children"]),
                    "hasMore": offset + limit < len(item["children"]),
                    "offset": offset,
                    "limit": limit,
                },
            )
        if not summary["isBuiltInDevice"]:
            return failure(
                request,
                "conflict",
                "Only built-in device items may be loaded",
            )
        if not item["isLoadable"] or item["isFolder"]:
            return failure(
                request,
                "conflict",
                "The selected browser item is not directly loadable",
            )
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
                "Track identity changed before browser load",
            )
        if root in ("instruments", "midi_effects") and track["kind"] != "midi":
            return failure(
                request,
                "conflict",
                "The selected browser item requires a MIDI track",
            )
        before = state.browser_load_state(track)
        device = state.simulated_device(item["name"])
        track["devices"].append(device)
        after = state.browser_load_state(track)
        return response(
            request,
            {
                "track": {
                    "index": index,
                    "reference": track["reference"],
                    "name": track["name"],
                    "kind": track["kind"],
                },
                "item": summary,
                "before": before,
                "after": after,
                "addedDevices": [
                    state.device_summary(index, len(track["devices"]) - 1, device)
                ],
                "addedDevicesTruncated": False,
                "verified": True,
            },
        )
    if command == "browser.search":
        query = params.get("query")
        roots = params.get(
            "roots", ["instruments", "audio_effects", "midi_effects"]
        )
        max_nodes = params.get("maxNodes", 128)
        max_results = params.get("maxResults", 20)
        max_depth = params.get("maxDepth", 4)
        max_duration_ms = params.get("maxDurationMs", 100)
        if (
            not isinstance(query, str)
            or not query.strip()
            or len(query) > 128
            or not isinstance(roots, list)
            or not roots
            or len(set(roots)) != len(roots)
            or any(root not in state.browser_roots for root in roots)
            or isinstance(max_nodes, bool)
            or not isinstance(max_nodes, int)
            or max_nodes < 1
            or max_nodes > 256
            or isinstance(max_results, bool)
            or not isinstance(max_results, int)
            or max_results < 1
            or max_results > 32
            or isinstance(max_depth, bool)
            or not isinstance(max_depth, int)
            or max_depth < 0
            or max_depth > 6
            or isinstance(max_duration_ms, bool)
            or not isinstance(max_duration_ms, int)
            or max_duration_ms < 10
            or max_duration_ms > 250
        ):
            return failure(
                request,
                "invalid_params",
                "Browser search parameters exceed bounded limits",
            )
        root_order = (
            "sounds",
            "drums",
            "instruments",
            "audio_effects",
            "midi_effects",
            "max_for_live",
            "plugins",
            "clips",
            "samples",
            "packs",
            "user_library",
            "current_project",
        )
        queue = deque()
        node_limit_truncated = False
        for root in root_order:
            if root not in roots:
                continue
            if len(queue) >= max_nodes:
                node_limit_truncated = True
                continue
            queue.append((root, state.browser_roots[root], [], 0))
        items = []
        visited = 0
        stop_reason = "complete"
        depth_limit_truncated = False
        normalized_query = query.strip().casefold()
        while queue:
            if visited >= max_nodes:
                stop_reason = "node_limit"
                break
            root, item, path, depth = queue.popleft()
            visited += 1
            if path and normalized_query in item["name"].casefold():
                items.append(state.browser_item_summary(root, path, item))
                if len(items) >= max_results:
                    stop_reason = "result_limit"
                    break
            if not item["isFolder"]:
                continue
            if depth >= max_depth:
                if item["children"]:
                    depth_limit_truncated = True
                continue
            for child_index, child in enumerate(item["children"]):
                if visited + len(queue) >= max_nodes:
                    node_limit_truncated = True
                    break
                queue.append(
                    (
                        root,
                        child,
                        path
                        + [{"index": child_index, "name": child["name"]}],
                        depth + 1,
                    )
                )
        if stop_reason == "complete" and node_limit_truncated:
            stop_reason = "node_limit"
        elif stop_reason == "complete" and depth_limit_truncated:
            stop_reason = "depth_limit"
        return response(
            request,
            {
                "query": query.strip(),
                "items": items,
                "visitedNodes": visited,
                "truncated": (
                    stop_reason != "complete"
                    or bool(queue)
                    or node_limit_truncated
                    or depth_limit_truncated
                ),
                "stopReason": stop_reason,
                "limits": {
                    "maxNodes": max_nodes,
                    "maxResults": max_results,
                    "maxDepth": max_depth,
                    "maxDurationMs": max_duration_ms,
                },
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
    if command == "transport.inspect_arrangement":
        offset = params.get("offset", 0)
        limit = params.get("limit", 100)
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset < 0
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or limit < 1
            or limit > 512
        ):
            return failure(
                request,
                "invalid_params",
                "offset and limit must describe a bounded cue-point page",
            )
        cue_points = sorted(state.cue_points, key=lambda cue: cue["time"])
        return response(
            request,
            {
                "loop": {
                    "enabled": state.loop_enabled,
                    "start": state.loop_start,
                    "length": state.loop_length,
                },
                "cuePoints": cue_points[offset : offset + limit],
                "totalCuePoints": len(cue_points),
                "offset": offset,
                "limit": limit,
            },
        )
    if command == "transport.set_arrangement_loop":
        if set(params.keys()) - set(["enabled", "start", "length"]) or not params:
            return failure(
                request,
                "invalid_params",
                "At least one Arrangement loop property is required",
            )
        enabled = params.get("enabled")
        start = params.get("start")
        length = params.get("length")
        if "enabled" in params and not isinstance(enabled, bool):
            return failure(request, "invalid_params", "enabled must be boolean")
        if "start" in params and (
            isinstance(start, bool)
            or not isinstance(start, (int, float))
            or not math.isfinite(start)
            or start < 0
            or start > 1576800
        ):
            return failure(
                request,
                "invalid_params",
                "start must be between 0 and 1576800 beats",
            )
        if "length" in params and (
            isinstance(length, bool)
            or not isinstance(length, (int, float))
            or not math.isfinite(length)
            or length <= 0
            or length > 1576800
        ):
            return failure(
                request,
                "invalid_params",
                "length must be greater than 0 and at most 1576800 beats",
            )
        target_start = start if "start" in params else state.loop_start
        target_length = (
            length if "length" in params else state.loop_length
        )
        if target_start + target_length > 1576800:
            return failure(
                request,
                "invalid_params",
                "Arrangement loop end must not exceed 1576800 beats",
            )
        before = {
            "enabled": state.loop_enabled,
            "start": state.loop_start,
            "length": state.loop_length,
        }
        if "enabled" in params:
            state.loop_enabled = enabled
        if "start" in params:
            state.loop_start = start
        if "length" in params:
            state.loop_length = length
        return response(
            request,
            {
                "before": before,
                "after": {
                    "enabled": state.loop_enabled,
                    "start": state.loop_start,
                    "length": state.loop_length,
                },
                "verified": True,
            },
        )
    if command == "transport.create_cue_point":
        if state.is_playing:
            return failure(
                request,
                "conflict",
                "Stop transport before creating a cue point",
            )
        time = params.get("time")
        name = params.get("name")
        if (
            isinstance(time, bool)
            or not isinstance(time, (int, float))
            or not math.isfinite(time)
            or time < 0
            or time > 1576800
        ):
            return failure(
                request,
                "invalid_params",
                "time must be between 0 and 1576800 beats",
            )
        if name is not None and (
            not isinstance(name, str)
            or not name.strip()
            or len(name) > 128
        ):
            return failure(
                request,
                "invalid_params",
                "name must be a non-empty string of at most 128 characters",
            )
        if any(abs(cue["time"] - time) < 0.000001 for cue in state.cue_points):
            return failure(
                request,
                "conflict",
                "A cue point already exists at the requested time",
            )
        before_count = len(state.cue_points)
        cue_point = {
            "reference": str(uuid.uuid4()),
            "name": name.strip() if name is not None else str(before_count + 1),
            "time": time,
        }
        state.cue_points.append(cue_point)
        return response(
            request,
            {
                "cuePoint": cue_point,
                "beforeCuePointCount": before_count,
                "afterCuePointCount": len(state.cue_points),
                "verified": True,
            },
        )
    if command == "transport.delete_cue_point":
        if state.is_playing:
            return failure(
                request,
                "conflict",
                "Stop transport before deleting a cue point",
            )
        target = next(
            (
                cue
                for cue in state.cue_points
                if cue["reference"] == params.get("expectedReference")
            ),
            None,
        )
        if target is None:
            return failure(request, "not_found", "Cue point no longer exists")
        if (
            target["name"] != params.get("expectedName")
            or target["time"] != params.get("expectedTime")
        ):
            return failure(
                request,
                "stale_reference",
                "Cue-point identity changed before deletion",
            )
        before_count = len(state.cue_points)
        state.cue_points.remove(target)
        return response(
            request,
            {
                "cuePoint": target,
                "beforeCuePointCount": before_count,
                "afterCuePointCount": len(state.cue_points),
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
            "playingSceneIndex": None,
            "devices": [],
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
    if command in (
        "devices.inspect",
        "devices.inspect_parameters",
        "devices.inspect_rack_chains",
        "devices.inspect_rack_chain_devices",
        "devices.inspect_drum_rack_pads",
        "devices.inspect_drum_pad_chains",
        "devices.inspect_drum_pad_chain_devices",
        "devices.set_enabled",
        "devices.set_parameter",
    ):
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
                "Track identity changed before device operation",
            )
        if command == "devices.inspect":
            offset = params.get("offset", 0)
            limit = params.get("limit", 32)
            if (
                isinstance(offset, bool)
                or not isinstance(offset, int)
                or offset < 0
                or isinstance(limit, bool)
                or not isinstance(limit, int)
                or limit < 1
                or limit > 128
            ):
                return failure(
                    request,
                    "invalid_params",
                    "offset and limit must describe a bounded device page",
                )
            devices = track["devices"]
            return response(
                request,
                {
                    "devices": [
                        state.device_summary(index, device_index, device)
                        for device_index, device in enumerate(
                            devices[offset : offset + limit], start=offset
                        )
                    ],
                    "total": len(devices),
                    "offset": offset,
                    "limit": limit,
                },
            )
        device_index = params.get("deviceIndex")
        if (
            isinstance(device_index, bool)
            or not isinstance(device_index, int)
            or device_index < 0
            or device_index >= len(track["devices"])
        ):
            return failure(request, "not_found", "Device index is out of range")
        device = track["devices"][device_index]
        if (
            device["reference"] != params.get("expectedDeviceReference")
            or device["name"] != params.get("expectedDeviceName")
        ):
            return failure(
                request,
                "stale_reference",
                "Device identity changed before operation",
            )
        if command in (
            "devices.inspect_rack_chains",
            "devices.inspect_rack_chain_devices",
        ):
            if not device["canHaveChains"]:
                return failure(
                    request, "conflict", "The targeted device is not a rack"
                )
            chains = device["chains"]
            if command == "devices.inspect_rack_chains":
                offset = params.get("offset", 0)
                limit = params.get("limit", 16)
                if (
                    isinstance(offset, bool)
                    or not isinstance(offset, int)
                    or offset < 0
                    or isinstance(limit, bool)
                    or not isinstance(limit, int)
                    or limit < 1
                    or limit > 64
                ):
                    return failure(
                        request,
                        "invalid_params",
                        "offset and limit must describe a bounded chain page",
                    )
                return response(
                    request,
                    {
                        "rack": state.device_summary(
                            index, device_index, device
                        ),
                        "chains": [
                            state.chain_summary(device, chain_index, chain)
                            for chain_index, chain in enumerate(
                                chains[offset : offset + limit],
                                start=offset,
                            )
                        ],
                        "total": len(chains),
                        "offset": offset,
                        "limit": limit,
                    },
                )
            chain_index = params.get("chainIndex")
            if (
                isinstance(chain_index, bool)
                or not isinstance(chain_index, int)
                or chain_index < 0
                or chain_index >= len(chains)
            ):
                return failure(request, "not_found", "Chain index is out of range")
            chain = chains[chain_index]
            if (
                chain["reference"] != params.get("expectedChainReference")
                or chain["name"] != params.get("expectedChainName")
            ):
                return failure(
                    request,
                    "stale_reference",
                    "Chain identity changed before inspection",
                )
            offset = params.get("offset", 0)
            limit = params.get("limit", 32)
            if (
                isinstance(offset, bool)
                or not isinstance(offset, int)
                or offset < 0
                or isinstance(limit, bool)
                or not isinstance(limit, int)
                or limit < 1
                or limit > 128
            ):
                return failure(
                    request,
                    "invalid_params",
                    "offset and limit must describe a bounded chain-device page",
                )
            devices = chain["devices"]
            return response(
                request,
                {
                    "rack": state.device_summary(index, device_index, device),
                    "chain": state.chain_summary(
                        device, chain_index, chain
                    ),
                    "devices": [
                        state.chain_device_summary(
                            chain, nested_index, nested_device
                        )
                        for nested_index, nested_device in enumerate(
                            devices[offset : offset + limit], start=offset
                        )
                    ],
                    "total": len(devices),
                    "offset": offset,
                    "limit": limit,
                },
            )
        if command in (
            "devices.inspect_drum_rack_pads",
            "devices.inspect_drum_pad_chains",
            "devices.inspect_drum_pad_chain_devices",
        ):
            if not device["canHaveDrumPads"]:
                return failure(
                    request,
                    "conflict",
                    "The targeted device is not a Drum Rack",
                )
            pads = device["drumPads"]
            if command == "devices.inspect_drum_rack_pads":
                offset = params.get("offset", 0)
                limit = params.get("limit", 32)
                if (
                    isinstance(offset, bool)
                    or not isinstance(offset, int)
                    or offset < 0
                    or isinstance(limit, bool)
                    or not isinstance(limit, int)
                    or limit < 1
                    or limit > 128
                ):
                    return failure(
                        request,
                        "invalid_params",
                        "offset and limit must describe a bounded drum-pad page",
                    )
                return response(
                    request,
                    {
                        "rack": state.device_summary(
                            index, device_index, device
                        ),
                        "pads": [
                            state.pad_summary(device, pad_index, pad)
                            for pad_index, pad in enumerate(
                                pads[offset : offset + limit], start=offset
                            )
                        ],
                        "total": len(pads),
                        "offset": offset,
                        "limit": limit,
                    },
                )
            pad_index = params.get("padIndex")
            if (
                isinstance(pad_index, bool)
                or not isinstance(pad_index, int)
                or pad_index < 0
                or pad_index >= len(pads)
            ):
                return failure(
                    request, "not_found", "Drum pad index is out of range"
                )
            pad = pads[pad_index]
            if (
                pad["reference"] != params.get("expectedPadReference")
                or pad["note"] != params.get("expectedPadNote")
                or pad["name"] != params.get("expectedPadName")
            ):
                return failure(
                    request,
                    "stale_reference",
                    "Drum pad identity changed before inspection",
                )
            chains = pad["chains"]
            if command == "devices.inspect_drum_pad_chains":
                offset = params.get("offset", 0)
                limit = params.get("limit", 8)
                if (
                    isinstance(offset, bool)
                    or not isinstance(offset, int)
                    or offset < 0
                    or isinstance(limit, bool)
                    or not isinstance(limit, int)
                    or limit < 1
                    or limit > 64
                ):
                    return failure(
                        request,
                        "invalid_params",
                        "offset and limit must describe a bounded pad-chain page",
                    )
                return response(
                    request,
                    {
                        "rack": state.device_summary(
                            index, device_index, device
                        ),
                        "pad": state.pad_summary(device, pad_index, pad),
                        "chains": [
                            state.pad_chain_summary(
                                device,
                                pad,
                                pad_index,
                                chain_index,
                                chain,
                            )
                            for chain_index, chain in enumerate(
                                chains[offset : offset + limit],
                                start=offset,
                            )
                        ],
                        "total": len(chains),
                        "offset": offset,
                        "limit": limit,
                    },
                )
            chain_index = params.get("chainIndex")
            if (
                isinstance(chain_index, bool)
                or not isinstance(chain_index, int)
                or chain_index < 0
                or chain_index >= len(chains)
            ):
                return failure(request, "not_found", "Chain index is out of range")
            chain = chains[chain_index]
            if (
                chain["reference"] != params.get("expectedChainReference")
                or chain["name"] != params.get("expectedChainName")
            ):
                return failure(
                    request,
                    "stale_reference",
                    "Chain identity changed before inspection",
                )
            offset = params.get("offset", 0)
            limit = params.get("limit", 32)
            if (
                isinstance(offset, bool)
                or not isinstance(offset, int)
                or offset < 0
                or isinstance(limit, bool)
                or not isinstance(limit, int)
                or limit < 1
                or limit > 128
            ):
                return failure(
                    request,
                    "invalid_params",
                    "offset and limit must describe a bounded chain-device page",
                )
            devices = chain["devices"]
            return response(
                request,
                {
                    "rack": state.device_summary(index, device_index, device),
                    "pad": state.pad_summary(device, pad_index, pad),
                    "chain": state.pad_chain_summary(
                        device, pad, pad_index, chain_index, chain
                    ),
                    "devices": [
                        state.chain_device_summary(
                            chain, nested_index, nested_device
                        )
                        for nested_index, nested_device in enumerate(
                            devices[offset : offset + limit], start=offset
                        )
                    ],
                    "total": len(devices),
                    "offset": offset,
                    "limit": limit,
                },
            )
        if command == "devices.inspect_parameters":
            offset = params.get("offset", 0)
            limit = params.get("limit", 64)
            if (
                isinstance(offset, bool)
                or not isinstance(offset, int)
                or offset < 0
                or isinstance(limit, bool)
                or not isinstance(limit, int)
                or limit < 1
                or limit > 256
            ):
                return failure(
                    request,
                    "invalid_params",
                    "offset and limit must describe a bounded parameter page",
                )
            parameters = device["parameters"]
            return response(
                request,
                {
                    "device": state.device_summary(index, device_index, device),
                    "parameters": [
                        state.parameter_summary(
                            device, parameter_index, parameter
                        )
                        for parameter_index, parameter in enumerate(
                            parameters[offset : offset + limit], start=offset
                        )
                    ],
                    "total": len(parameters),
                    "offset": offset,
                    "limit": limit,
                },
            )
        if command == "devices.set_enabled":
            enabled = params.get("enabled")
            if not isinstance(enabled, bool):
                return failure(request, "invalid_params", "enabled is required")
            if (
                not device["parameters"]
                or device["parameters"][0]["name"] != "Device On"
            ):
                return failure(
                    request,
                    "unsupported_capability",
                    "Device does not expose a documented Device On parameter",
                )
            parameter = device["parameters"][0]
            if not parameter["isEnabled"] or not parameter["isWritable"]:
                return failure(
                    request, "conflict", "Device On parameter is not writable"
                )
            before = parameter["value"] >= 0.5
            parameter["value"] = 1.0 if enabled else 0.0
            return response(
                request,
                {
                    "device": state.device_summary(index, device_index, device),
                    "beforeEnabled": before,
                    "afterEnabled": enabled,
                    "verified": True,
                },
            )
        parameter_index = params.get("parameterIndex")
        if (
            isinstance(parameter_index, bool)
            or not isinstance(parameter_index, int)
            or parameter_index < 0
            or parameter_index >= len(device["parameters"])
        ):
            return failure(
                request, "not_found", "Parameter index is out of range"
            )
        parameter = device["parameters"][parameter_index]
        if (
            parameter["reference"] != params.get("expectedParameterReference")
            or parameter["name"] != params.get("expectedParameterName")
        ):
            return failure(
                request,
                "stale_reference",
                "Parameter identity changed before mutation",
            )
        normalized = params.get("normalizedValue")
        if (
            isinstance(normalized, bool)
            or not isinstance(normalized, (int, float))
            or not math.isfinite(normalized)
            or normalized < 0
            or normalized > 1
        ):
            return failure(
                request,
                "invalid_params",
                "normalizedValue must be between 0 and 1",
            )
        if not parameter["isEnabled"] or not parameter["isWritable"]:
            return failure(request, "conflict", "Parameter is not writable")
        before = state.parameter_summary(device, parameter_index, parameter)
        if parameter["isQuantized"]:
            steps = max(1, parameter["valueItemCount"] - 1)
            step_index = int(math.floor(normalized * steps + 0.5))
            parameter["value"] = parameter["min"] + (
                (parameter["max"] - parameter["min"]) * step_index / steps
            )
        else:
            parameter["value"] = parameter["min"] + (
                parameter["max"] - parameter["min"]
            ) * normalized
        return response(
            request,
            {
                "device": state.device_summary(index, device_index, device),
                "before": before,
                "after": state.parameter_summary(
                    device, parameter_index, parameter
                ),
                "requestedNormalizedValue": normalized,
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
                "muted": False,
                "looping": True,
                "isPlaying": False,
                "isTriggered": False,
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
    if command in (
        "clips.launch",
        "clips.duplicate",
        "clips.delete",
        "clips.set_properties",
    ):
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
        source = track["clips"][scene_index]
        if source is None:
            return failure(request, "not_found", "Clip slot is empty")
        if source["reference"] != params.get("expectedClipReference"):
            return failure(
                request,
                "stale_reference",
                "Clip identity changed before mutation",
            )
        if command == "clips.launch":
            previous_scene_index = track["playingSceneIndex"]
            previous = (
                track["clips"][previous_scene_index]
                if previous_scene_index is not None
                else None
            )
            before = {
                "trackPlayingSceneIndex": previous_scene_index,
                "trackPlayingClipReference": (
                    previous["reference"] if previous is not None else None
                ),
                "targetIsPlaying": source["isPlaying"],
                "targetIsTriggered": source["isTriggered"],
            }
            if source["isPlaying"] or source["isTriggered"]:
                return response(
                    request,
                    {
                        "clip": state.session_clip_summary(
                            index, scene_index, source
                        ),
                        "before": before,
                        "after": before,
                        "verified": True,
                    },
                )
            source["isPlaying"] = False
            source["isTriggered"] = True
            after = {
                "trackPlayingSceneIndex": previous_scene_index,
                "trackPlayingClipReference": (
                    previous["reference"] if previous is not None else None
                ),
                "targetIsPlaying": False,
                "targetIsTriggered": True,
            }
            return response(
                request,
                {
                    "clip": state.session_clip_summary(
                        index, scene_index, source
                    ),
                    "before": before,
                    "after": after,
                    "verified": True,
                },
            )
        if command == "clips.duplicate":
            destination_index = params.get("destinationTrackIndex")
            destination_scene_index = params.get("destinationSceneIndex")
            if (
                isinstance(destination_index, bool)
                or not isinstance(destination_index, int)
                or destination_index < 0
                or destination_index >= len(state.tracks)
                or isinstance(destination_scene_index, bool)
                or not isinstance(destination_scene_index, int)
                or destination_scene_index < 0
                or destination_scene_index >= 2
            ):
                return failure(
                    request,
                    "not_found",
                    "Destination track or scene is out of range",
                )
            destination_track = state.tracks[destination_index]
            if (
                destination_track["reference"]
                != params.get("expectedDestinationTrackReference")
                or destination_track["name"]
                != params.get("expectedDestinationTrackName")
            ):
                return failure(
                    request,
                    "stale_reference",
                    "Destination track identity changed before duplication",
                )
            if destination_track["clips"][destination_scene_index] is not None:
                return failure(
                    request, "conflict", "Destination clip slot is occupied"
                )
            duplicated = dict(source)
            duplicated["reference"] = str(uuid.uuid4())
            duplicated["notes"] = list(source.get("notes", []))
            duplicated["isPlaying"] = False
            duplicated["isTriggered"] = False
            destination_track["clips"][destination_scene_index] = duplicated
            return response(
                request,
                {
                    "sourceClip": state.session_clip_summary(
                        index, scene_index, source
                    ),
                    "clip": state.session_clip_summary(
                        destination_index,
                        destination_scene_index,
                        duplicated,
                    ),
                    "verified": True,
                },
            )
        if command == "clips.delete":
            before_count = len(
                [clip for clip in track["clips"] if clip is not None]
            )
            summary = state.session_clip_summary(index, scene_index, source)
            track["clips"][scene_index] = None
            if track["playingSceneIndex"] == scene_index:
                track["playingSceneIndex"] = None
            return response(
                request,
                {
                    "clip": summary,
                    "beforeClipCount": before_count,
                    "afterClipCount": before_count - 1,
                    "verified": True,
                },
            )
        updates = {
            key: params[key]
            for key in ("name", "muted", "looping")
            if key in params
        }
        if not updates:
            return failure(
                request,
                "invalid_params",
                "At least one clip property is required",
            )
        if "name" in updates:
            if (
                not isinstance(updates["name"], str)
                or not updates["name"].strip()
                or len(updates["name"]) > 128
            ):
                return failure(
                    request,
                    "invalid_params",
                    "name must be a non-empty string",
                )
            updates["name"] = updates["name"].strip()
        if "muted" in updates and not isinstance(updates["muted"], bool):
            return failure(request, "invalid_params", "muted must be a boolean")
        if "looping" in updates and not isinstance(updates["looping"], bool):
            return failure(request, "invalid_params", "looping must be a boolean")
        before = {
            key: source.get(key) for key in ("name", "muted", "looping")
        }
        source.update(updates)
        after = {
            key: source.get(key) for key in ("name", "muted", "looping")
        }
        return response(
            request,
            {
                "clip": state.session_clip_summary(index, scene_index, source),
                "before": before,
                "after": after,
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
            "notes": [],
            "noteCount": 0,
            "muted": False,
            "looping": True,
        }
        track["arrangementClips"].append(clip)
        return response(request, {"clip": clip, "verified": True})
    if command == "arrangement.duplicate_clip":
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
        source = track["clips"][scene_index]
        if source is None:
            return failure(request, "not_found", "Clip slot is empty")
        if source["reference"] != params.get("expectedClipReference"):
            return failure(
                request,
                "stale_reference",
                "Source clip identity changed before duplication",
            )
        if source["kind"] != "midi":
            return failure(
                request,
                "unsupported_capability",
                "Safe Session-to-Arrangement duplication currently requires a MIDI clip",
            )
        destination_time = params.get("destinationTime")
        if (
            isinstance(destination_time, bool)
            or not isinstance(destination_time, (int, float))
            or destination_time < 0
        ):
            return failure(
                request,
                "invalid_params",
                "destinationTime must be a non-negative number",
            )
        destination_end = destination_time + source["length"]
        if destination_end > 1576800:
            return failure(
                request,
                "invalid_params",
                "Duplicated Arrangement clip end exceeds the maximum time",
            )
        if any(
            destination_time < existing["endTime"]
            and destination_end > existing["startTime"]
            for existing in track["arrangementClips"]
        ):
            return failure(
                request,
                "conflict",
                "Arrangement range overlaps an existing clip",
            )
        before_count = len(track["arrangementClips"])
        clip = {
            "reference": str(uuid.uuid4()),
            "trackReference": track["reference"],
            "trackIndex": index,
            "name": source["name"],
            "kind": source["kind"],
            "startTime": destination_time,
            "endTime": destination_end,
            "length": source["length"],
            "notes": list(source.get("notes", [])),
            "noteCount": (
                len(source.get("notes", []))
                if source["kind"] == "midi"
                else None
            ),
            "muted": False,
            "looping": True,
        }
        track["arrangementClips"].append(clip)
        return response(
            request,
            {
                "sourceClip": {
                    "reference": source["reference"],
                    "trackReference": track["reference"],
                    "trackIndex": index,
                    "sceneIndex": scene_index,
                    "name": source["name"],
                    "kind": source["kind"],
                    "length": source["length"],
                    "noteCount": (
                        len(source.get("notes", []))
                        if source["kind"] == "midi"
                        else None
                    ),
                },
                "clip": {
                    key: value for key, value in clip.items() if key != "notes"
                },
                "beforeClipCount": before_count,
                "afterClipCount": len(track["arrangementClips"]),
                "verified": True,
            },
        )
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
    if command == "arrangement.replace_notes":
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
                "Arrangement clip changed before note replacement",
            )
        if target["kind"] != "midi":
            return failure(
                request, "conflict", "Arrangement clip is not a MIDI clip"
            )
        notes = params.get("notes", [])
        if any(
            note["startTime"] + note["duration"]
            > target["length"] + 0.000001
            for note in notes
        ):
            return failure(
                request,
                "invalid_params",
                "Notes must fit within the clip length",
            )
        before_count = len(target["notes"])
        if before_count and not params.get("allowPerNoteExpressionLoss"):
            return failure(
                request,
                "conflict",
                "Replacing notes may discard per-note expression data",
            )
        target["notes"] = notes
        target["noteCount"] = len(target["notes"])
        return response(
            request,
            {
                "clip": {
                    key: value
                    for key, value in target.items()
                    if key != "notes"
                },
                "beforeNoteCount": before_count,
                "afterNoteCount": len(target["notes"]),
                "verified": True,
            },
        )
    if command == "arrangement.set_clip_properties":
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
                "Arrangement clip changed before property update",
            )
        updates = {
            key: params[key]
            for key in ("name", "muted", "looping")
            if key in params
        }
        if not updates:
            return failure(
                request,
                "invalid_params",
                "At least one clip property is required",
            )
        if "name" in updates:
            if not isinstance(updates["name"], str) or not updates["name"].strip():
                return failure(
                    request,
                    "invalid_params",
                    "name must be a non-empty string",
                )
            updates["name"] = updates["name"].strip()
        if "muted" in updates and not isinstance(updates["muted"], bool):
            return failure(request, "invalid_params", "muted must be a boolean")
        if "looping" in updates and not isinstance(updates["looping"], bool):
            return failure(request, "invalid_params", "looping must be a boolean")
        before = {
            key: target[key] for key in ("name", "muted", "looping")
        }
        target.update(updates)
        after = {
            key: target[key] for key in ("name", "muted", "looping")
        }
        return response(
            request,
            {
                "clip": {
                    key: value
                    for key, value in target.items()
                    if key != "notes"
                },
                "before": before,
                "after": after,
                "verified": True,
            },
        )
    return failure(request, "unknown_command", "Unknown command: {0}".format(command))


def serve(host, port, token, connections=1):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(1)
    print(
        json.dumps({"host": host, "port": server.getsockname()[1]}),
        flush=True,
    )
    state = SimulatorState()
    try:
        for _ in range(connections):
            connection, _address = server.accept()
            decoder = FrameDecoder()
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
    finally:
        server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    parser.add_argument("--connections", type=int, default=1)
    args = parser.parse_args()
    if args.connections < 1:
        parser.error("--connections must be at least 1")
    serve(args.host, args.port, args.token, args.connections)


if __name__ == "__main__":
    main()
