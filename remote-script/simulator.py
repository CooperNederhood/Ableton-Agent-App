"""Standalone protocol simulator for bridge integration tests and development."""

from __future__ import absolute_import, print_function, unicode_literals

import argparse
import copy
import json
import math
import socket
import time
import uuid
from collections import deque

from AbletonAgent.protocol import FrameDecoder, encode_frame
from AbletonAgent.core_domain_commands import (
    ROUTING_SNAPSHOT_LIMIT,
    ROUTING_SNAPSHOT_SECONDS,
    validate_audio_inspect,
    validate_audio_mutate,
    validate_midi_inspect,
    validate_midi_mutate,
    validate_mixer_inspect,
    validate_mixer_mutate,
    validate_scenes_inspect,
    validate_scenes_mutate,
    validate_tracks_inspect,
    validate_tracks_mutate,
    validate_transport_inspect,
    validate_transport_mutate,
)

from AbletonAgent.version import PROTOCOL_VERSION, REMOTE_SCRIPT_VERSION

LIVE_11_MAX_COLOR_INDEX = 69


def simulated_palette_color(color_index):
    return (color_index + 1) * 0x010101


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
                "firedSceneIndex": None,
                "recording": False,
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
                "firedSceneIndex": None,
                "recording": False,
                "devices": [self.simulated_device("Operator")],
            },
        ]
        self.scenes = [
            {
                "reference": str(uuid.uuid4()),
                "name": "Scene 1",
                "colorIndex": 1,
                "tempo": 120.0,
                "tempoEnabled": False,
                "numerator": 4,
                "denominator": 4,
                "timeSignatureEnabled": False,
                "isTriggered": False,
            },
            {
                "reference": str(uuid.uuid4()),
                "name": "Scene 2",
                "colorIndex": 2,
                "tempo": 120.0,
                "tempoEnabled": False,
                "numerator": 4,
                "denominator": 4,
                "timeSignatureEnabled": False,
                "isTriggered": False,
            },
        ]
        self.return_tracks = []
        self.master_track = {
            "reference": str(uuid.uuid4()),
            "name": "Master",
            "kind": "audio",
            "color": None,
            "isMuted": False,
            "isSoloed": False,
            "isArmed": False,
            "devices": [],
        }
        for track in self.tracks + [self.master_track]:
            self.initialize_core_track(track)
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.metronome = False
        self.launch_quantization = 4
        self.record_quantization = 4
        self.link_enabled = False
        self.back_to_arrangement = False
        self.current_song_time = 0.0
        self.routing_snapshots = {}
        self.next_note_id = 1
        self.live_event_subscriptions = {}
        self.live_event_messages = deque()
        self.live_event_sequence = 0
        self.browser_roots = self.create_browser_roots()

    def initialize_core_track(self, track):
        track.setdefault("colorIndex", track.get("color"))
        track.setdefault("isGroup", False)
        track.setdefault("isFolded", False)
        track.setdefault("monitoringState", 1)
        track.setdefault("canBeArmed", track.get("kind") == "midi")
        track.setdefault("backToArrangement", False)
        track.setdefault("playingSceneIndex", None)
        track.setdefault("clips", [None for _scene in self.scenes])
        track.setdefault("arrangementClips", [])
        track.setdefault("volumeParameterReference", str(uuid.uuid4()))
        track.setdefault("panParameterReference", str(uuid.uuid4()))
        track.setdefault("sendValues", [0.0])
        track.setdefault("sendReferences", [str(uuid.uuid4())])
        track.setdefault("crossfadeAssignment", 1)
        track.setdefault("crossfader", 0.5)
        track.setdefault("crossfaderReference", str(uuid.uuid4()))
        track.setdefault("cueVolume", 0.5)
        track.setdefault("cueVolumeReference", str(uuid.uuid4()))
        track.setdefault(
            "routing",
            {
                "input-type": "All Ins",
                "input-channel": "All Channels",
                "output-type": "Master",
                "output-channel": "Track In",
            },
        )
        track.setdefault(
            "routingOptions",
            {
                "input-type": ["All Ins", "External MIDI"],
                "input-channel": ["All Channels", "Channel 1"],
                "output-type": ["Master", track.get("name", "")],
                "output-channel": ["Track In", "External MIDI"],
            },
        )

    def live_event_target(self, track, device=None, parameter=None):
        target = {
            "trackReference": track["reference"],
            "track": {"name": track["name"]},
        }
        if track.get("color") is not None:
            target["track"]["color"] = "#{0:06X}".format(
                track["color"] & 0xFFFFFF
            )
        if device is not None:
            target["deviceReference"] = device["reference"]
        if parameter is not None:
            target["parameterReference"] = parameter["reference"]
        return target

    def live_event_resolution(self, target):
        result = {
            "status": "resolved",
            "projectId": "simulated-project",
        }
        result.update(target)
        return result

    def live_event_state(self, subscription):
        track = subscription["track"]
        kind = subscription["kind"]
        if kind == "parameter.value_changed":
            parameter = subscription["parameter"]
            value = parameter["value"]
            span = parameter["max"] - parameter["min"]
            normalized = (
                0.0 if span == 0 else (value - parameter["min"]) / span
            )
            return {
                "normalizedValue": min(1.0, max(0.0, normalized)),
                "value": value,
                "displayValue": "{0:.6g}".format(value),
            }
        if kind == "track.playing_clip_changed":
            index = track["playingSceneIndex"]
            if index == -2:
                return {"state": "arrangement"}
            if index is None:
                return {"state": "stopped"}
            result = {"state": "session-clip", "slotIndex": index}
            clip = track["clips"][index]
            if clip is not None and clip["name"]:
                result["clipName"] = clip["name"]
            return result
        if kind == "track.triggered_clip_changed":
            index = track["firedSceneIndex"]
            if index == -2:
                return {"state": "stop"}
            if index is None:
                return {"state": "none"}
            result = {"state": "session-clip", "slotIndex": index}
            clip = track["clips"][index]
            if clip is not None and clip["name"]:
                result["clipName"] = clip["name"]
            return result
        return {
            "recording": bool(track["recording"]),
            "source": (
                "arrangement"
                if track["playingSceneIndex"] == -2
                else "session-clip"
                if track["playingSceneIndex"] is not None
                else "track"
            ),
        }

    def publish_live_event_changes(self):
        for event_id in sorted(self.live_event_subscriptions):
            subscription = self.live_event_subscriptions[event_id]
            current = self.live_event_state(subscription)
            previous = subscription["state"]
            if current == previous:
                continue
            subscription["state"] = current
            sequence = self.live_event_sequence
            self.live_event_sequence += 1
            payload = {
                "occurrenceId": str(
                    uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        "{0}:{1}".format(event_id, sequence),
                    )
                ),
                "eventId": event_id,
                "kind": subscription["kind"],
                "sequence": sequence,
                "projectRevision": 0,
                "observedAt": "2000-01-01T00:00:{0:02d}Z".format(
                    sequence % 60
                ),
                "target": subscription["target"],
                "previous": previous,
                "current": current,
                "summary": "Simulator Live event changed",
            }
            self.live_event_messages.append({
                "protocolVersion": PROTOCOL_VERSION,
                "kind": "event",
                "event": "live_event.occurred",
                "sequence": sequence,
                "payload": payload,
            })

    def invalidate_live_event(self, event_id, reason):
        sequence = self.live_event_sequence
        self.live_event_sequence += 1
        self.live_event_messages.append({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "event",
            "event": "live_event.invalidated",
            "sequence": sequence,
            "payload": {
                "eventId": event_id,
                "observedAt": "2000-01-01T00:00:{0:02d}Z".format(
                    sequence % 60
                ),
                "projectRevision": 0,
                "reason": reason,
            },
        })

    def browser_item(
        self,
        name,
        uri,
        children=None,
        loadable=False,
        device=False,
        source="",
        folder=None,
    ):
        return {
            "reference": str(uuid.uuid5(uuid.NAMESPACE_URL, uri)),
            "name": name,
            "uri": uri,
            "isFolder": children is not None if folder is None else folder,
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
            "drums": self.browser_item(
                "Drums",
                "ableton://drums",
                [
                    self.browser_item(
                        "808 Core Kit.adg",
                        "ableton://drums/808-core-kit",
                        loadable=True,
                        device=False,
                        source="drums",
                    )
                ],
                folder=False,
            ),
            "packs": self.browser_item(
                "Packs",
                "ableton://packs",
                [
                    self.browser_item(
                        "Warm Pad.adg",
                        "ableton://packs/warm-pad",
                        loadable=True,
                        device=True,
                        source="packs",
                    )
                ],
                folder=False,
            ),
            "user_library": self.browser_item(
                "User Library",
                "ableton://user_library",
                [
                    self.browser_item(
                        "My Bass.adv",
                        "file:///Music/Ableton/User Library/My Bass.adv",
                        loadable=True,
                        device=True,
                        source="user_library",
                    )
                ],
                folder=False,
            ),
        }
        for key, name in (
            ("sounds", "Sounds"),
            ("max_for_live", "Max for Live"),
            ("plugins", "Plug-ins"),
            ("clips", "Clips"),
            ("samples", "Samples"),
            ("current_project", "Current Project"),
        ):
            roots[key] = self.browser_item(
                name, "ableton://{0}".format(key), []
            )
        return roots

    def browser_item_summary(self, root, path, item):
        source = item["source"].strip().casefold().replace(" ", "_")
        uri = item["uri"].strip().casefold()
        is_navigable = item["isFolder"] or bool(item["children"])
        is_loadable_device = (
            (
                item["isDevice"]
                or item["name"].strip().casefold().endswith(
                    (".adv", ".adg", ".amxd")
                )
            )
            and item["isLoadable"]
            and not is_navigable
            and root != "plugins"
            and not any(
                marker in source
                for marker in ("plugin", "vst", "audio_unit")
            )
            and not any(
                marker in uri
                for marker in ("plugin", "vst", "audio_unit", "external")
            )
        )
        return {
            "reference": item["reference"],
            "root": root,
            "path": path,
            "name": item["name"],
            "uri": item["uri"],
            "isFolder": item["isFolder"],
            "isNavigable": is_navigable,
            "isLoadable": item["isLoadable"],
            "isDevice": item["isDevice"],
            "source": item["source"],
            "isLoadableDevice": is_loadable_device,
            "isBuiltInDevice": is_loadable_device,
        }

    def resolve_browser_item(self, root, path):
        item = self.browser_roots.get(root)
        if item is None:
            return None
        for segment in path:
            index = segment.get("index")
            if (
                not (item["isFolder"] or item["children"])
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
        def parameter(parameter_name, value):
            return {
                "reference": str(uuid.uuid4()),
                "name": parameter_name,
                "value": value,
                "min": 0.0,
                "max": 1.0,
                "isEnabled": True,
            }

        return {
            "reference": str(uuid.uuid4()),
            "name": name,
            "color": simulated_palette_color(5),
            "colorIndex": 5,
            "mute": False,
            "solo": False,
            "mixer": {
                "volume": parameter("Chain Volume", 0.8),
                "pan": parameter("Chain Pan", 0.5),
                "sends": [parameter("Send A", 0.0)],
            },
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
                {
                    "index": index,
                    "devices": [
                        self.device_summary(index, device_index, device)
                        for device_index, device in enumerate(
                            track["devices"][:32]
                        )
                    ],
                    "devicesTruncated": len(track["devices"]) > 32,
                },
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

    def chain_mixer_summary(self, chain):
        def parameter_summary(parameter):
            span = parameter["max"] - parameter["min"]
            normalized = (
                0.0
                if span == 0
                else (parameter["value"] - parameter["min"]) / span
            )
            return dict(parameter, normalizedValue=normalized)

        return {
            "mute": chain["mute"],
            "solo": chain["solo"],
            "volume": parameter_summary(chain["mixer"]["volume"]),
            "pan": parameter_summary(chain["mixer"]["pan"]),
            "sends": [
                parameter_summary(parameter)
                for parameter in chain["mixer"]["sends"]
            ],
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

    def resolve_track_identity(self, identity):
        index = identity.get("index")
        if not isinstance(index, int) or index < 0 or index >= len(self.tracks):
            return None
        track = self.tracks[index]
        if (
            track["reference"] != identity.get("expectedReference")
            or track["name"] != identity.get("expectedName")
        ):
            return None
        return track

    def resolve_indexed_identity(self, values, identity):
        index = identity.get("index")
        if not isinstance(index, int) or index < 0 or index >= len(values):
            return None
        value = values[index]
        if (
            value["reference"] != identity.get("expectedReference")
            or value["name"] != identity.get("expectedName")
        ):
            return None
        return value

    def resolve_chain_target(self, target):
        track = self.resolve_track_identity(target.get("track", {}))
        if track is None:
            return None
        rack = self.resolve_indexed_identity(
            track["devices"], target.get("rack", {})
        )
        if rack is None:
            return None
        pad = None
        chains = rack["chains"]
        if target.get("kind") in (
            "drum-pad-chain",
            "drum-pad-chain-device",
        ):
            pad = self.resolve_indexed_identity(
                rack["drumPads"], target.get("pad", {})
            )
            if (
                pad is None
                or pad["note"] != target["pad"].get("expectedNote")
            ):
                return None
            chains = pad["chains"]
        chain = self.resolve_indexed_identity(
            chains, target.get("chain", {})
        )
        if chain is None:
            return None
        return track, rack, pad, chain

    def resolve_device_location(self, target):
        track = self.resolve_track_identity(target.get("track", {}))
        if track is None:
            return None
        if target.get("kind") == "track-device":
            device = self.resolve_indexed_identity(
                track["devices"], target.get("device", {})
            )
            return (
                None
                if device is None
                else (track, None, None, None, track["devices"], device)
            )
        resolved = self.resolve_chain_target(target)
        if resolved is None:
            return None
        track, rack, pad, chain = resolved
        device = self.resolve_indexed_identity(
            chain["devices"], target.get("device", {})
        )
        return (
            None
            if device is None
            else (track, rack, pad, chain, chain["devices"], device)
        )

    def resolve_device_destination(self, target):
        track = self.resolve_track_identity(target.get("track", {}))
        if track is None:
            return None
        if target.get("kind") == "track":
            return track, None, None, None, track["devices"]
        resolved = self.resolve_chain_target(target)
        if resolved is None:
            return None
        track, rack, pad, chain = resolved
        return track, rack, pad, chain, chain["devices"]

    def device_location_summary(
        self, kind, track, rack, pad, chain, devices, device
    ):
        result = {
            "kind": kind,
            "track": {
                "index": self.tracks.index(track),
                "reference": track["reference"],
                "name": track["name"],
            },
            "device": {
                "index": devices.index(device),
                "reference": device["reference"],
                "name": device["name"],
            },
        }
        if rack is not None:
            result["rack"] = {
                "index": track["devices"].index(rack),
                "reference": rack["reference"],
                "name": rack["name"],
            }
        if chain is not None:
            chains = pad["chains"] if pad is not None else rack["chains"]
            result["chain"] = {
                "index": chains.index(chain),
                "reference": chain["reference"],
                "name": chain["name"],
            }
        if pad is not None:
            result["pad"] = {
                "index": rack["drumPads"].index(pad),
                "reference": pad["reference"],
                "note": pad["note"],
                "name": pad["name"],
            }
        return result

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


def _sim_scene_summary(scene, index):
    return {
        "index": index,
        "reference": scene["reference"],
        "name": scene["name"],
        "colorIndex": scene.get("colorIndex"),
        "tempo": scene.get("tempo"),
        "tempoEnabled": scene.get("tempoEnabled"),
        "timeSignature": {
            "numerator": scene["numerator"],
            "denominator": scene["denominator"],
            "enabled": scene.get("timeSignatureEnabled"),
        },
        "isTriggered": scene.get("isTriggered"),
    }


def _sim_track_summary(track, kind, index):
    return {
        "kind": kind,
        "index": index,
        "reference": track["reference"],
        "name": track["name"],
        "trackType": track["kind"],
        "colorIndex": track.get("colorIndex"),
        "isGroup": bool(track.get("isGroup", False)),
        "isFolded": (
            bool(track.get("isFolded"))
            if "isFolded" in track
            else None
        ),
        "monitoringState": track.get("monitoringState"),
        "canBeArmed": bool(track.get("canBeArmed", False)),
        "isArmed": bool(track.get("isArmed", False)),
        "isMuted": bool(track.get("isMuted", False)),
        "isSoloed": bool(track.get("isSoloed", False)),
        "backToArrangement": track.get("backToArrangement"),
    }


def _sim_resolve_track(state, target):
    kind = target["kind"]
    if kind == "regular":
        tracks = state.tracks
        index = target["index"]
        if index >= len(tracks):
            return None, "not_found"
        track = tracks[index]
    elif kind == "return":
        tracks = state.return_tracks
        index = target["index"]
        if index >= len(tracks):
            return None, "not_found"
        track = tracks[index]
    else:
        track = state.master_track
    if (
        track["reference"] != target["expectedReference"]
        or track["name"] != target["expectedName"]
    ):
        return None, "stale_reference"
    return track, None


def _sim_resolve_clip(state, target):
    track, error = _sim_resolve_track(state, target["track"])
    if error:
        return None, error
    if target["view"] == "session":
        index = target["sceneIndex"]
        if index >= len(track["clips"]) or track["clips"][index] is None:
            return None, "not_found"
        clip = track["clips"][index]
    else:
        clip = next(
            (
                candidate
                for candidate in track["arrangementClips"]
                if candidate["reference"]
                == target["expectedClipReference"]
            ),
            None,
        )
        if clip is None:
            return None, "not_found"
        if abs(
            clip.get("startTime", clip.get("start", 0.0))
            - target["expectedStartTime"]
        ) > 0.000001:
            return None, "stale_reference"
    if (
        clip["reference"] != target["expectedClipReference"]
        or clip["name"] != target["expectedClipName"]
    ):
        return None, "stale_reference"
    return clip, None


def _sim_parameter(reference, name, normalized):
    return {
        "reference": reference,
        "name": name,
        "normalizedValue": normalized,
        "value": normalized,
        "displayValue": "{0:.3f}".format(normalized),
    }


def _sim_mixer_summary(track, target):
    sends = [
        _sim_parameter(reference, "Send {0}".format(index + 1), value)
        for index, (reference, value) in enumerate(
            zip(track["sendReferences"], track["sendValues"])
        )
    ]
    return {
        "target": _sim_track_summary(
            track, target["kind"], target.get("index")
        ),
        "volume": _sim_parameter(
            track["volumeParameterReference"], "Volume", track["volume"]
        ),
        "pan": _sim_parameter(
            track["panParameterReference"],
            "Pan",
            (track["pan"] + 1.0) / 2.0,
        ),
        "sends": sends,
        "activator": not track["isMuted"],
        "crossfadeAssignment": track.get("crossfadeAssignment"),
        "crossfader": (
            _sim_parameter(
                track["crossfaderReference"],
                "Crossfader",
                track["crossfader"],
            )
            if target["kind"] == "master"
            else None
        ),
        "cueVolume": (
            _sim_parameter(
                track["cueVolumeReference"],
                "Cue Volume",
                track["cueVolume"],
            )
            if target["kind"] == "master"
            else None
        ),
    }


def _sim_transport_state(state):
    return {
        "currentSongTime": state.current_song_time,
        "isPlaying": state.is_playing,
        "tempo": state.tempo,
        "timeSignature": {
            "numerator": state.signature_numerator,
            "denominator": state.signature_denominator,
        },
        "metronome": state.metronome,
        "launchQuantization": state.launch_quantization,
        "recordQuantization": state.record_quantization,
        "linkEnabled": state.link_enabled,
        "backToArrangement": state.back_to_arrangement,
    }


def _sim_audio_summary(clip):
    return {
        "reference": clip["reference"],
        "name": clip["name"],
        "length": clip["length"],
        "gain": clip.get("gain"),
        "pitchCoarse": clip.get("pitchCoarse"),
        "pitchFine": clip.get("pitchFine"),
        "warping": clip.get("warping"),
        "warpMode": clip.get("warpMode"),
        "availableWarpModes": list(clip.get("availableWarpModes", [])),
        "startMarker": clip.get("startMarker"),
        "endMarker": clip.get("endMarker"),
        "loopStart": clip.get("loopStart"),
        "loopEnd": clip.get("loopEnd"),
        "looping": clip.get("looping"),
        "ramMode": clip.get("ramMode"),
        "filePath": clip.get("filePath"),
        "sampleLength": clip.get("sampleLength"),
        "sampleRate": clip.get("sampleRate"),
    }


def _active_sim_routing_snapshots(state, now):
    state.routing_snapshots = {
        snapshot_id: snapshot
        for snapshot_id, snapshot in state.routing_snapshots.items()
        if (
            isinstance(snapshot.get("created"), (int, float))
            and 0 <= now - snapshot["created"] <= ROUTING_SNAPSHOT_SECONDS
        )
    }
    return state.routing_snapshots


def _store_sim_routing_snapshot(state, snapshot_id, snapshot, now):
    snapshots = _active_sim_routing_snapshots(state, now)
    while len(snapshots) >= ROUTING_SNAPSHOT_LIMIT:
        oldest_id = min(
            snapshots,
            key=lambda candidate: (
                snapshots[candidate]["created"],
                candidate,
            ),
        )
        snapshots.pop(oldest_id)
    snapshots[snapshot_id] = snapshot


def _handle_sim_scenes(request, params, state):
    action = params["action"]
    if action == "list":
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return response(
            request,
            {
                "action": action,
                "scenes": [
                    _sim_scene_summary(scene, index)
                    for index, scene in enumerate(
                        state.scenes[offset : offset + limit], start=offset
                    )
                ],
                "total": len(state.scenes),
                "offset": offset,
                "limit": limit,
            },
        )
    if action == "create":
        before = len(state.scenes)
        index = params["index"]
        if index > before:
            return failure(request, "not_found", "Scene index is out of range")
        actual = before if index == -1 else index
        scene = {
            "reference": str(uuid.uuid4()),
            "name": params.get("name", "Scene {0}".format(actual + 1)).strip(),
            "colorIndex": None,
            "tempo": state.tempo,
            "tempoEnabled": False,
            "numerator": state.signature_numerator,
            "denominator": state.signature_denominator,
            "timeSignatureEnabled": False,
            "isTriggered": False,
        }
        state.scenes.insert(actual, scene)
        for track in state.tracks + state.return_tracks:
            track["clips"].insert(actual, None)
        return response(
            request,
            {
                "action": action,
                "beforeSceneCount": before,
                "afterSceneCount": len(state.scenes),
                "scene": _sim_scene_summary(scene, actual),
                "verified": True,
            },
        )
    target = params["target"]
    if target["index"] >= len(state.scenes):
        return failure(request, "not_found", "Scene index is out of range")
    scene = state.scenes[target["index"]]
    if (
        scene["reference"] != target["expectedReference"]
        or scene["name"] != target["expectedName"]
    ):
        return failure(request, "stale_reference", "Scene identity changed")
    index = target["index"]
    if action == "get":
        return response(
            request,
            {"action": action, "scene": _sim_scene_summary(scene, index)},
        )
    if action == "duplicate":
        before = len(state.scenes)
        duplicate = copy.deepcopy(scene)
        duplicate["reference"] = str(uuid.uuid4())
        state.scenes.insert(index + 1, duplicate)
        for track in state.tracks + state.return_tracks:
            source = track["clips"][index]
            copied = copy.deepcopy(source)
            if copied is not None:
                copied["reference"] = str(uuid.uuid4())
            track["clips"].insert(index + 1, copied)
        return response(
            request,
            {
                "action": action,
                "beforeSceneCount": before,
                "afterSceneCount": len(state.scenes),
                "scene": _sim_scene_summary(duplicate, index + 1),
                "verified": True,
            },
        )
    if action in ("rename", "set-color", "set-tempo-time-signature"):
        before = _sim_scene_summary(scene, index)
        if action == "rename":
            scene["name"] = params["name"].strip()
        elif action == "set-color":
            scene["colorIndex"] = params["colorIndex"]
        elif params["state"]["kind"] == "tempo":
            scene["tempo"] = params["state"]["tempo"]
            scene["tempoEnabled"] = params["state"]["enabled"]
        else:
            scene["numerator"] = params["state"]["numerator"]
            scene["denominator"] = params["state"]["denominator"]
            scene["timeSignatureEnabled"] = params["state"]["enabled"]
        return response(
            request,
            {
                "action": action,
                "before": before,
                "after": _sim_scene_summary(scene, index),
                "verified": True,
            },
        )
    if action == "fire":
        for candidate in state.scenes:
            candidate["isTriggered"] = False
        scene["isTriggered"] = True
        return response(
            request,
            {
                "action": action,
                "scene": _sim_scene_summary(scene, index),
                "verified": True,
            },
        )
    before = len(state.scenes)
    deleted = _sim_scene_summary(scene, index)
    del state.scenes[index]
    for track in state.tracks + state.return_tracks:
        del track["clips"][index]
    return response(
        request,
        {
            "action": action,
            "deleted": deleted,
            "beforeSceneCount": before,
            "afterSceneCount": len(state.scenes),
            "verified": True,
        },
    )


def _handle_sim_tracks(request, params, state):
    action = params["action"]
    if action == "list":
        selected = []
        kind = params.get("trackKind", "all")
        if kind in ("regular", "all"):
            selected.extend(
                (track, "regular", index)
                for index, track in enumerate(state.tracks)
            )
        if kind in ("return", "all"):
            selected.extend(
                (track, "return", index)
                for index, track in enumerate(state.return_tracks)
            )
        if kind in ("master", "all"):
            selected.append((state.master_track, "master", None))
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return response(
            request,
            {
                "action": action,
                "tracks": [
                    _sim_track_summary(track, track_kind, index)
                    for track, track_kind, index in selected[
                        offset : offset + limit
                    ]
                ],
                "total": len(selected),
                "offset": offset,
                "limit": limit,
            },
        )
    if action == "create-return":
        before = len(state.return_tracks)
        track = {
            "reference": str(uuid.uuid4()),
            "name": params.get("name", "Return {0}".format(before + 1)).strip(),
            "kind": "audio",
            "color": None,
            "isMuted": False,
            "isSoloed": False,
            "isArmed": False,
            "devices": [],
        }
        state.initialize_core_track(track)
        state.return_tracks.append(track)
        return response(
            request,
            {
                "action": action,
                "track": _sim_track_summary(track, "return", before),
                "beforeReturnTrackCount": before,
                "afterReturnTrackCount": len(state.return_tracks),
                "verified": True,
            },
        )
    target = params["target"]
    track, error = _sim_resolve_track(state, target)
    if error:
        return failure(request, error, "Track identity changed")
    if action == "get":
        return response(
            request,
            {
                "action": action,
                "track": _sim_track_summary(
                    track, target["kind"], target.get("index")
                ),
            },
        )
    if action == "duplicate":
        before = len(state.tracks)
        duplicate = copy.deepcopy(track)
        duplicate["reference"] = str(uuid.uuid4())
        duplicate["name"] = track["name"] + " Copy"
        duplicate["volumeParameterReference"] = str(uuid.uuid4())
        duplicate["panParameterReference"] = str(uuid.uuid4())
        duplicate["sendReferences"] = [str(uuid.uuid4())]
        state.tracks.insert(target["index"] + 1, duplicate)
        return response(
            request,
            {
                "action": action,
                "source": _sim_track_summary(
                    track, "regular", target["index"]
                ),
                "track": _sim_track_summary(
                    duplicate, "regular", target["index"] + 1
                ),
                "beforeTrackCount": before,
                "afterTrackCount": len(state.tracks),
                "verified": True,
            },
        )
    if action in (
        "set-color",
        "set-monitoring",
        "set-fold",
        "stop-clips",
        "back-to-arrangement",
    ):
        before = _sim_track_summary(
            track, target["kind"], target.get("index")
        )
        if action == "set-color":
            track["colorIndex"] = params["colorIndex"]
        elif action == "set-monitoring":
            track["monitoringState"] = params["monitoringState"]
        elif action == "set-fold":
            if not track["isGroup"]:
                return failure(
                    request,
                    "unsupported_capability",
                    "Track folding is unavailable",
                )
            track["isFolded"] = params["folded"]
        elif action == "stop-clips":
            track["playingSceneIndex"] = None
            for clip in track["clips"]:
                if clip is not None:
                    clip["isPlaying"] = False
                    clip["isTriggered"] = False
        else:
            track["backToArrangement"] = False
        return response(
            request,
            {
                "action": action,
                "result": {
                    "before": before,
                    "after": _sim_track_summary(
                        track, target["kind"], target.get("index")
                    ),
                    "verified": True,
                },
            },
        )
    collection = (
        state.tracks
        if target["kind"] == "regular"
        else state.return_tracks
    )
    before = len(collection)
    deleted = _sim_track_summary(
        track, target["kind"], target["index"]
    )
    del collection[target["index"]]
    return response(
        request,
        {
            "action": action,
            "deleted": deleted,
            "beforeCount": before,
            "afterCount": len(collection),
            "verified": True,
        },
    )


def _handle_sim_mixer(request, params, state):
    action = params["action"]
    target = params.get("target") or params.get("value", {}).get("target")
    track, error = _sim_resolve_track(state, target)
    if error:
        return failure(request, error, "Track identity changed")
    if action == "inspect":
        return response(
            request,
            {"action": action, "mixer": _sim_mixer_summary(track, target)},
        )
    if action == "meters":
        return response(
            request,
            {
                "action": action,
                "inputLeft": 0.25,
                "inputRight": 0.2,
                "outputLeft": 0.5,
                "outputRight": 0.45,
                "observedAt": "2000-01-01T00:00:00Z",
            },
        )
    if action in ("set-volume", "set-pan"):
        value = params["value"]
        field = "volume" if action == "set-volume" else "pan"
        reference = track[
            "volumeParameterReference"
            if field == "volume"
            else "panParameterReference"
        ]
        expected_name = "Volume" if field == "volume" else "Pan"
        if (
            reference != value["expectedParameterReference"]
            or expected_name != value["expectedParameterName"]
        ):
            return failure(
                request, "stale_reference", "Parameter identity changed"
            )
        before = (
            _sim_parameter(reference, expected_name, track[field])
            if field == "volume"
            else _sim_parameter(
                reference, expected_name, (track[field] + 1.0) / 2.0
            )
        )
        normalized = value["normalizedValue"]
        track[field] = normalized if field == "volume" else normalized * 2 - 1
        after = _sim_parameter(reference, expected_name, normalized)
        return response(
            request,
            {
                "action": action,
                "result": {
                    "before": before,
                    "after": after,
                    "verified": True,
                },
            },
        )
    if action == "set-send":
        index = params["sendIndex"]
        if index >= len(track["sendValues"]):
            return failure(request, "not_found", "Send index is out of range")
        reference = track["sendReferences"][index]
        name = "Send {0}".format(index + 1)
        if (
            reference != params["expectedParameterReference"]
            or name != params["expectedParameterName"]
        ):
            return failure(
                request, "stale_reference", "Parameter identity changed"
            )
        before = _sim_parameter(
            reference, name, track["sendValues"][index]
        )
        track["sendValues"][index] = params["normalizedValue"]
        return response(
            request,
            {
                "action": action,
                "result": {
                    "before": before,
                    "after": _sim_parameter(
                        reference, name, track["sendValues"][index]
                    ),
                    "verified": True,
                },
            },
        )
    if action == "set-activator":
        before = not track["isMuted"]
        track["isMuted"] = not params["active"]
        return response(
            request,
            {
                "action": action,
                "before": before,
                "after": params["active"],
                "verified": True,
            },
        )
    if action == "set-crossfade-assignment":
        before = track["crossfadeAssignment"]
        track["crossfadeAssignment"] = params["assignment"]
        return response(
            request,
            {
                "action": action,
                "before": before,
                "after": track["crossfadeAssignment"],
                "verified": True,
            },
        )
    if action in ("set-master-crossfader", "set-cue-volume"):
        if target["kind"] != "master":
            return failure(
                request, "invalid_params", "The target must be master"
            )
        value = params["value"]
        field = (
            "crossfader"
            if action == "set-master-crossfader"
            else "cueVolume"
        )
        reference_field = field + "Reference"
        name = "Crossfader" if field == "crossfader" else "Cue Volume"
        if (
            track[reference_field] != value["expectedParameterReference"]
            or name != value["expectedParameterName"]
        ):
            return failure(
                request, "stale_reference", "Parameter identity changed"
            )
        before = _sim_parameter(track[reference_field], name, track[field])
        track[field] = value["normalizedValue"]
        return response(
            request,
            {
                "action": action,
                "result": {
                    "before": before,
                    "after": _sim_parameter(
                        track[reference_field], name, track[field]
                    ),
                    "verified": True,
                },
            },
        )
    direction = params["direction"]
    if action == "routing-options":
        snapshot_id = str(uuid.uuid4())
        options = []
        token_map = {}
        current_token = None
        warnings = []
        for display in track["routingOptions"][direction]:
            token = str(uuid.uuid4())
            option = {
                "token": token,
                "displayName": display,
                "isExternalMidi": "external midi" in display.lower(),
            }
            options.append(option)
            token_map[token] = option
            if display == track["routing"][direction]:
                current_token = token
            if option["isExternalMidi"]:
                warnings.append(
                    "This routing option targets external MIDI; verify connected hardware."
                )
            if (
                direction.startswith("output")
                and track["name"].lower() in display.lower()
            ):
                warnings.append(
                    "This routing option may create an audio or MIDI feedback loop."
                )
        now = time.time()
        _store_sim_routing_snapshot(state, snapshot_id, {
            "created": now,
            "target": copy.deepcopy(target),
            "direction": direction,
            "options": token_map,
        }, now)
        return response(
            request,
            {
                "action": action,
                "snapshotId": snapshot_id,
                "options": options,
                "currentOptionToken": current_token,
                "warnings": list(dict.fromkeys(warnings))[:8],
            },
        )
    snapshots = _active_sim_routing_snapshots(state, time.time())
    snapshot = snapshots.get(params["snapshotId"])
    if (
        snapshot is None
        or snapshot["target"] != target
        or snapshot["direction"] != direction
    ):
        return failure(
            request, "stale_reference", "Routing snapshot is stale"
        )
    option = snapshot["options"].get(params["optionToken"])
    if (
        option is None
        or option["displayName"] != params["expectedDisplayName"]
    ):
        return failure(
            request, "stale_reference", "Routing option identity changed"
        )
    before_display = track["routing"][direction]
    before = next(
        (
            candidate
            for candidate in snapshot["options"].values()
            if candidate["displayName"] == before_display
        ),
        None,
    )
    if before is None:
        return failure(
            request,
            "stale_reference",
            "Current routing option was not in the snapshot",
        )
    track["routing"][direction] = option["displayName"]
    warnings = []
    if option["isExternalMidi"]:
        warnings.append(
            "This routing option targets external MIDI; verify connected hardware."
        )
    if (
        direction.startswith("output")
        and track["name"].lower() in option["displayName"].lower()
    ):
        warnings.append(
            "This routing option may create an audio or MIDI feedback loop."
        )
    snapshots.pop(params["snapshotId"], None)
    return response(
        request,
        {
            "action": action,
            "before": before,
            "after": option,
            "warnings": warnings,
            "verified": True,
        },
    )


def _handle_sim_transport(request, params, state):
    action = params["action"]
    if action == "get":
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        cues = sorted(state.cue_points, key=lambda cue: cue["time"])
        return response(
            request,
            {
                "action": action,
                "transport": _sim_transport_state(state),
                "cuePoints": cues[offset : offset + limit],
                "totalCuePoints": len(cues),
                "offset": offset,
                "limit": limit,
            },
        )
    if action in ("rename-cue", "jump-to-cue"):
        target = params["target"]
        cue = next(
            (
                item
                for item in state.cue_points
                if item["reference"] == target["expectedReference"]
            ),
            None,
        )
        if (
            cue is None
            or cue["name"] != target["expectedName"]
            or abs(cue["time"] - target["expectedTime"]) > 0.000001
        ):
            return failure(
                request, "stale_reference", "Cue point identity changed"
            )
        if action == "rename-cue":
            before = dict(cue)
            cue["name"] = params["name"].strip()
            return response(
                request,
                {
                    "action": action,
                    "before": before,
                    "after": dict(cue),
                    "verified": True,
                },
            )
        before = state.current_song_time
        state.current_song_time = cue["time"]
        return response(
            request,
            {
                "action": action,
                "cuePoint": dict(cue),
                "beforeTime": before,
                "afterTime": state.current_song_time,
                "verified": True,
            },
        )
    before = _sim_transport_state(state)
    if action == "seek":
        state.current_song_time = params["time"]
    elif action == "jump":
        state.current_song_time = max(
            0.0, state.current_song_time + params["beats"]
        )
    elif action == "set-time-signature":
        state.signature_numerator = params["numerator"]
        state.signature_denominator = params["denominator"]
    elif action == "set-metronome":
        state.metronome = params["enabled"]
    elif action == "set-launch-quantization":
        state.launch_quantization = params["quantization"]
    elif action == "set-record-quantization":
        state.record_quantization = params["quantization"]
    elif action == "set-link":
        state.link_enabled = params["enabled"]
    else:
        state.back_to_arrangement = False
    return response(
        request,
        {
            "action": action,
            "before": before,
            "after": _sim_transport_state(state),
            "verified": True,
        },
    )


def _handle_sim_midi(request, params, state):
    clip, error = _sim_resolve_clip(state, params["target"])
    if error:
        return failure(request, error, "Clip identity changed")
    if clip.get("kind") != "midi":
        return failure(request, "conflict", "The target is not a MIDI clip")
    notes = clip.setdefault("notes", [])
    action = params["action"]
    if action == "query":
        start = params.get("fromTime", 0)
        end = start + params.get("timeSpan", 1576800)
        low = params.get("fromPitch", 0)
        high = low + params.get("pitchSpan", 128)
        selected = [
            note
            for note in notes
            if start <= note["startTime"] < end
            and low <= note["pitch"] < high
        ]
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return response(
            request,
            {
                "action": action,
                "notes": selected[offset : offset + limit],
                "total": len(selected),
                "offset": offset,
                "limit": limit,
                "truncated": offset + limit < len(selected),
            },
        )
    before_count = len(notes)
    by_id = dict((note.get("noteId"), note) for note in notes)
    affected = []
    if action == "add":
        for requested in params["notes"]:
            note = dict(requested)
            note["noteId"] = state.next_note_id
            state.next_note_id += 1
            notes.append(note)
            affected.append(note["noteId"])
    elif action == "update":
        if any(note["noteId"] not in by_id for note in params["notes"]):
            return failure(
                request, "stale_reference", "MIDI note identity changed"
            )
        for requested in params["notes"]:
            by_id[requested["noteId"]].update(requested)
            affected.append(requested["noteId"])
    elif action == "remove":
        if any(note_id not in by_id for note_id in params["noteIds"]):
            return failure(
                request, "stale_reference", "MIDI note identity changed"
            )
        affected = list(params["noteIds"])
        clip["notes"] = [
            note for note in notes if note["noteId"] not in affected
        ]
        notes = clip["notes"]
    elif action == "duplicate":
        if any(note_id not in by_id for note_id in params["noteIds"]):
            return failure(
                request, "stale_reference", "MIDI note identity changed"
            )
        copies = []
        for note_id in params["noteIds"]:
            copied = dict(by_id[note_id])
            copied["noteId"] = state.next_note_id
            state.next_note_id += 1
            copied["startTime"] += params["timeOffset"]
            copied["pitch"] += params.get("pitchOffset", 0)
            if (
                copied["startTime"] < 0
                or copied["pitch"] < 0
                or copied["pitch"] > 127
            ):
                return failure(
                    request,
                    "invalid_params",
                    "Duplicated notes exceed clip bounds",
                )
            copies.append(copied)
            affected.append(copied["noteId"])
        notes.extend(copies)
    else:
        if any(note_id not in by_id for note_id in params["noteIds"]):
            return failure(
                request, "stale_reference", "MIDI note identity changed"
            )
        for note_id in params["noteIds"]:
            note = by_id[note_id]
            snapped = round(
                note["startTime"] / params["gridBeats"]
            ) * params["gridBeats"]
            note["startTime"] = max(
                0.0,
                note["startTime"]
                + (snapped - note["startTime"]) * params["amount"],
            )
            affected.append(note_id)
    return response(
        request,
        {
            "action": action,
            "beforeNoteCount": before_count,
            "afterNoteCount": len(notes),
            "affectedNoteIds": affected,
            "verified": True,
        },
    )


def _handle_sim_audio(request, params, state):
    clip, error = _sim_resolve_clip(state, params["target"])
    if error:
        return failure(request, error, "Clip identity changed")
    if clip.get("kind") != "audio":
        return failure(request, "conflict", "The target is not an audio clip")
    action = params["action"]
    if action == "inspect":
        return response(
            request, {"action": action, "clip": _sim_audio_summary(clip)}
        )
    if action == "warp-markers":
        markers = clip.get("warpMarkers", [])
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return response(
            request,
            {
                "action": action,
                "markers": [
                    dict({"index": index}, **marker)
                    for index, marker in enumerate(
                        markers[offset : offset + limit], start=offset
                    )
                ],
                "total": len(markers),
                "offset": offset,
                "limit": limit,
            },
        )
    before = _sim_audio_summary(clip)
    if action == "set-gain":
        clip["gain"] = params["gain"]
    elif action == "set-pitch":
        clip["pitchCoarse"] = params["coarse"]
        clip["pitchFine"] = params["fine"]
    elif action == "set-warp":
        clip["warping"] = params["enabled"]
    elif action == "set-warp-mode":
        expected_modes = sorted(params["expectedAvailableWarpModes"])
        current_modes = sorted(clip.get("availableWarpModes", []))
        if expected_modes != current_modes:
            return failure(
                request,
                "stale_reference",
                "Available warp modes changed since inspection",
            )
        if params["warpMode"] not in current_modes:
            return failure(
                request,
                "invalid_params",
                "Selected warp mode is not currently available",
            )
        clip["warpMode"] = params["warpMode"]
    elif action == "set-ram-mode":
        clip["ramMode"] = params["enabled"]
    elif params["markers"]["kind"] == "start-end":
        clip["startMarker"] = params["markers"]["startMarker"]
        clip["endMarker"] = params["markers"]["endMarker"]
    else:
        clip["loopStart"] = params["markers"]["loopStart"]
        clip["loopEnd"] = params["markers"]["loopEnd"]
        clip["looping"] = params["markers"]["looping"]
    return response(
        request,
        {
            "action": action,
            "before": before,
            "after": _sim_audio_summary(clip),
            "verified": True,
        },
    )


def _handle_core_domain(request, command, params, state):
    handlers = {
        "scenes.inspect": (validate_scenes_inspect, _handle_sim_scenes),
        "scenes.mutate": (validate_scenes_mutate, _handle_sim_scenes),
        "tracks.inspect": (validate_tracks_inspect, _handle_sim_tracks),
        "tracks.mutate": (validate_tracks_mutate, _handle_sim_tracks),
        "mixer_routing.inspect": (
            validate_mixer_inspect,
            _handle_sim_mixer,
        ),
        "mixer_routing.mutate": (
            validate_mixer_mutate,
            _handle_sim_mixer,
        ),
        "transport.inspect": (
            validate_transport_inspect,
            _handle_sim_transport,
        ),
        "transport.mutate": (
            validate_transport_mutate,
            _handle_sim_transport,
        ),
        "midi_notes.inspect": (validate_midi_inspect, _handle_sim_midi),
        "midi_notes.mutate": (validate_midi_mutate, _handle_sim_midi),
        "audio_clips.inspect": (
            validate_audio_inspect,
            _handle_sim_audio,
        ),
        "audio_clips.mutate": (
            validate_audio_mutate,
            _handle_sim_audio,
        ),
    }
    entry = handlers.get(command)
    if entry is None:
        return None
    validation_error = entry[0](params)
    if validation_error:
        return failure(request, "invalid_params", validation_error)
    return entry[1](request, params, state)


def handle(request, token, state):
    if request.get("kind") != "request":
        return None
    command = request.get("command")
    params = request.get("params", {})
    core_response = _handle_core_domain(request, command, params, state)
    if core_response is not None:
        return core_response
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
                "remoteScriptVersion": REMOTE_SCRIPT_VERSION,
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
                    "devices.find_position": True,
                    "devices.inspect_chain_mixer": True,
                    "devices.move": True,
                    "devices.set_chain_properties": True,
                    "devices.set_chain_mixer": True,
                    "devices.set_enabled": True,
                    "devices.set_parameter": True,
                    "browser.inspect_roots": True,
                    "browser.inspect_children": True,
                    "browser.search": True,
                    "browser.load_item": True,
                    "clips.create_midi": True,
                    "clips.inspect_notes": True,
                    "clips.replace_notes": True,
                    "clips.launch": True,
                    "clips.duplicate": True,
                    "clips.delete": True,
                    "clips.set_properties": True,
                    "arrangement.create_midi_clip": True,
                    "arrangement.inspect": True,
                    "arrangement.inspect_notes": True,
                    "arrangement.delete_clip": True,
                    "arrangement.replace_notes": True,
                    "arrangement.duplicate_clip": True,
                    "arrangement.set_clip_properties": True,
                    "events.inspect_selection": True,
                    "events.subscribe": True,
                    "events.unsubscribe": True,
                    "events.list_subscriptions": True,
                    "events.clear_subscriptions": True,
                    "events.parameter.value_changed": True,
                    "events.track.playing_clip_changed": True,
                    "events.track.triggered_clip_changed": True,
                    "events.track.recording_state_changed": True,
                    "scenes.list": True,
                    "scenes.get": True,
                    "scenes.create": True,
                    "scenes.duplicate": True,
                    "scenes.rename": True,
                    "scenes.set_color": True,
                    "scenes.set_tempo_time_signature": True,
                    "scenes.fire": True,
                    "scenes.delete": True,
                    "tracks.list": True,
                    "tracks.get": True,
                    "tracks.create_return": True,
                    "tracks.duplicate": True,
                    "tracks.set_color": True,
                    "tracks.set_monitoring": True,
                    "tracks.set_fold": True,
                    "tracks.stop_clips": True,
                    "tracks.back_to_arrangement": True,
                    "tracks.delete": True,
                    "mixer_routing.inspect": True,
                    "mixer_routing.meters": True,
                    "mixer_routing.set_volume": True,
                    "mixer_routing.set_pan": True,
                    "mixer_routing.set_send": True,
                    "mixer_routing.set_activator": True,
                    "mixer_routing.set_crossfade_assignment": True,
                    "mixer_routing.set_master_crossfader": True,
                    "mixer_routing.set_cue_volume": True,
                    "mixer_routing.routing_options": True,
                    "mixer_routing.set_routing": True,
                    "transport.get": True,
                    "transport.seek": True,
                    "transport.jump": True,
                    "transport.set_time_signature": True,
                    "transport.set_metronome": True,
                    "transport.set_launch_quantization": True,
                    "transport.set_record_quantization": True,
                    "transport.set_link": True,
                    "transport.rename_cue": True,
                    "transport.jump_to_cue": True,
                    "transport.back_to_arrangement": True,
                    "midi_notes.query": True,
                    "midi_notes.add": True,
                    "midi_notes.update": True,
                    "midi_notes.remove": True,
                    "midi_notes.duplicate": True,
                    "midi_notes.quantize": True,
                    "audio_clips.inspect": True,
                    "audio_clips.set_gain": True,
                    "audio_clips.set_pitch": True,
                    "audio_clips.set_warp": True,
                    "audio_clips.set_warp_mode": True,
                    "audio_clips.set_markers": True,
                    "audio_clips.set_ram_mode": True,
                    "audio_clips.warp_markers": True,
                },
                "limits": {
                    "maxFrameBytes": 4 * 1024 * 1024,
                    "maxBatchItems": 128,
                },
            },
        )
    if command == "system.ping":
        return response(request, {"pong": True})
    if command == "events.inspect_selection":
        if params:
            return failure(
                request, "invalid_params", "Command does not accept parameters"
            )
        track = state.tracks[0]
        device = track["devices"][0]
        parameter = device["parameters"][1]
        track_target = {
            "index": 0,
            "expectedReference": track["reference"],
            "expectedName": track["name"],
        }
        parameter_target = dict(track_target)
        parameter_target.update({
            "deviceIndex": 0,
            "expectedDeviceReference": device["reference"],
            "expectedDeviceName": device["name"],
            "parameterIndex": 1,
            "expectedParameterReference": parameter["reference"],
            "expectedParameterName": parameter["name"],
        })
        return response(
            request,
            {"track": track_target, "parameter": parameter_target},
        )
    if command == "events.subscribe":
        kinds = (
            "parameter.value_changed",
            "track.playing_clip_changed",
            "track.triggered_clip_changed",
            "track.recording_state_changed",
        )
        event_id = params.get("eventId")
        kind = params.get("kind")
        index = params.get("index")
        if (
            not isinstance(event_id, str)
            or not event_id.startswith("live-event.")
            or kind not in kinds
            or params.get("projectId") != "simulated-project"
            or isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(state.tracks)
        ):
            return failure(
                request, "invalid_params", "Invalid Live event subscription"
            )
        if event_id in state.live_event_subscriptions:
            return failure(
                request, "conflict", "Event ID is already subscribed"
            )
        track = state.tracks[index]
        if (
            track["reference"] != params.get("expectedReference")
            or track["name"] != params.get("expectedName")
        ):
            return failure(
                request,
                "stale_reference",
                "Track identity changed before subscribe",
            )
        device = None
        parameter = None
        if kind == "parameter.value_changed":
            device_index = params.get("deviceIndex")
            parameter_index = params.get("parameterIndex")
            if (
                isinstance(device_index, bool)
                or not isinstance(device_index, int)
                or device_index < 0
                or device_index >= len(track["devices"])
            ):
                return failure(
                    request, "not_found", "Device index is out of range"
                )
            device = track["devices"][device_index]
            if (
                device["reference"] != params.get("expectedDeviceReference")
                or device["name"] != params.get("expectedDeviceName")
                or isinstance(parameter_index, bool)
                or not isinstance(parameter_index, int)
                or parameter_index < 0
                or parameter_index >= len(device["parameters"])
            ):
                return failure(
                    request, "stale_reference", "Device identity changed"
                )
            parameter = device["parameters"][parameter_index]
            if (
                parameter["reference"]
                != params.get("expectedParameterReference")
                or parameter["name"] != params.get("expectedParameterName")
            ):
                return failure(
                    request, "stale_reference", "Parameter identity changed"
                )
        subscription = {
            "eventId": event_id,
            "kind": kind,
            "track": track,
            "parameter": parameter,
            "target": state.live_event_target(track, device, parameter),
        }
        subscription["state"] = state.live_event_state(subscription)
        state.live_event_subscriptions[event_id] = subscription
        resolution = state.live_event_resolution(subscription["target"])
        return response(
            request,
            {
                "eventId": event_id,
                "kind": kind,
                "target": subscription["target"],
                "resolution": resolution,
                "state": subscription["state"],
                "initialState": {
                    "kind": kind,
                    "state": subscription["state"],
                },
            },
        )
    if command == "events.unsubscribe":
        event_id = params.get("eventId")
        if set(params.keys()) != set(["eventId"]):
            return failure(
                request, "invalid_params", "eventId is required"
            )
        if state.live_event_subscriptions.pop(event_id, None) is None:
            return failure(
                request, "not_found", "Subscription was not found"
            )
        return response(
            request, {"eventId": event_id, "unsubscribed": True}
        )
    if command == "events.list_subscriptions":
        if params:
            return failure(
                request, "invalid_params", "Command does not accept parameters"
            )
        return response(
            request,
            {
                "subscriptions": [
                    {
                        "eventId": item["eventId"],
                        "kind": item["kind"],
                        "target": item["target"],
                        "state": item["state"],
                        "resolution": state.live_event_resolution(
                            item["target"]
                        ),
                    }
                    for _event_id, item in sorted(
                        state.live_event_subscriptions.items()
                    )
                ]
            },
        )
    if command == "events.clear_subscriptions":
        if params:
            return failure(
                request, "invalid_params", "Command does not accept parameters"
            )
        event_ids = sorted(state.live_event_subscriptions)
        state.live_event_subscriptions = {}
        for event_id in event_ids:
            state.invalidate_live_event(event_id, "subscription-cleared")
        return response(request, {"clearedEventIds": event_ids})
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
            if not summary["isNavigable"]:
                return failure(
                    request,
                    "conflict",
                    "The targeted browser item is not a navigable container",
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
        if not summary["isLoadableDevice"]:
            return failure(
                request,
                "conflict",
                "Only supported device or device-preset items may be loaded",
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
        if root in (
            "drums",
            "instruments",
            "midi_effects",
        ) and track["kind"] != "midi":
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
            if not (item["isFolder"] or item["children"]):
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
            "clips": [None for _scene in state.scenes],
            "arrangementClips": [],
            "playingSceneIndex": None,
            "firedSceneIndex": None,
            "recording": False,
            "devices": [],
        }
        state.initialize_core_track(track)
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
        invalidated = [
            event_id
            for event_id, subscription in state.live_event_subscriptions.items()
            if subscription["track"] is track
        ]
        del state.tracks[index]
        for event_id in sorted(invalidated):
            del state.live_event_subscriptions[event_id]
            state.invalidate_live_event(event_id, "target-deleted")
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
    if command in ("devices.find_position", "devices.move"):
        source_target = params.get("source", {})
        destination_target = params.get("destination", {})
        source = state.resolve_device_location(source_target)
        destination = state.resolve_device_destination(destination_target)
        if source is None or destination is None:
            return failure(
                request,
                "stale_reference",
                "Device or parent identity changed before operation",
            )
        (
            source_track,
            source_rack,
            source_pad,
            source_chain,
            source_devices,
            device,
        ) = source
        (
            destination_track,
            destination_rack,
            destination_pad,
            destination_chain,
            destination_devices,
        ) = destination
        source_index = source_devices.index(device)
        requested_index = destination_target.get("deviceIndex")
        same_parent = source_devices is destination_devices
        maximum = len(destination_devices) - (1 if same_parent else 0)
        if (
            isinstance(requested_index, bool)
            or not isinstance(requested_index, int)
            or requested_index < 0
            or requested_index > maximum
        ):
            return failure(
                request, "not_found", "Destination device index is out of range"
            )
        api_position = (
            requested_index + 1
            if same_parent and source_index < requested_index
            else requested_index
        )
        source_summary = state.device_location_summary(
            source_target["kind"],
            source_track,
            source_rack,
            source_pad,
            source_chain,
            source_devices,
            device,
        )
        destination_summary = {
            "kind": destination_target["kind"],
            "track": {
                "index": state.tracks.index(destination_track),
                "reference": destination_track["reference"],
                "name": destination_track["name"],
            },
            "deviceIndex": requested_index,
        }
        if destination_rack is not None:
            destination_summary["rack"] = {
                "index": destination_track["devices"].index(destination_rack),
                "reference": destination_rack["reference"],
                "name": destination_rack["name"],
            }
        if destination_chain is not None:
            chains = (
                destination_pad["chains"]
                if destination_pad is not None
                else destination_rack["chains"]
            )
            destination_summary["chain"] = {
                "index": chains.index(destination_chain),
                "reference": destination_chain["reference"],
                "name": destination_chain["name"],
            }
        if destination_pad is not None:
            destination_summary["pad"] = {
                "index": destination_rack["drumPads"].index(destination_pad),
                "reference": destination_pad["reference"],
                "note": destination_pad["note"],
                "name": destination_pad["name"],
            }
        if command == "devices.find_position":
            return response(
                request,
                {
                    "source": source_summary,
                    "destination": destination_summary,
                    "requestedIndex": requested_index,
                    "resolvedIndex": requested_index,
                    "apiTargetPosition": api_position,
                    "sameParent": same_parent,
                    "exact": True,
                },
            )
        source_devices.remove(device)
        destination_devices.insert(requested_index, device)
        after_kind = destination_target["kind"] + "-device"
        after = state.device_location_summary(
            after_kind,
            destination_track,
            destination_rack,
            destination_pad,
            destination_chain,
            destination_devices,
            device,
        )
        return response(
            request,
            {
                "deviceReference": device["reference"],
                "before": source_summary,
                "after": after,
                "requestedDestinationIndex": requested_index,
                "preflightIndex": requested_index,
                "moveReturnedIndex": requested_index,
                "sameParent": same_parent,
                "verified": True,
            },
        )
    if command in (
        "devices.inspect_chain_mixer",
        "devices.set_chain_properties",
        "devices.set_chain_mixer",
    ):
        resolved = state.resolve_chain_target(params.get("target", {}))
        if resolved is None:
            return failure(
                request,
                "stale_reference",
                "Chain identity changed before operation",
            )
        _track, rack, _pad, chain = resolved
        if command == "devices.inspect_chain_mixer":
            return response(
                request,
                {
                    "chainReference": chain["reference"],
                    "mixer": state.chain_mixer_summary(chain),
                },
            )
        if command == "devices.set_chain_properties":
            color_index = params.get("colorIndex")
            if (
                set(params.keys()) - set(["target", "name", "colorIndex"])
                or ("name" not in params and "colorIndex" not in params)
                or (
                    "colorIndex" in params
                    and (
                        isinstance(color_index, bool)
                        or not isinstance(color_index, int)
                        or color_index < 0
                        or color_index > LIVE_11_MAX_COLOR_INDEX
                    )
                )
            ):
                return failure(
                    request,
                    "invalid_params",
                    "colorIndex must be an integer between 0 and 69",
                )
            before = {
                "name": chain["name"],
                "color": chain["color"],
                "colorIndex": chain["colorIndex"],
            }
            if "name" in params:
                chain["name"] = params["name"]
            if "colorIndex" in params:
                chain["colorIndex"] = params["colorIndex"]
                chain["color"] = simulated_palette_color(
                    params["colorIndex"]
                )
            return response(
                request,
                {
                    "chainReference": chain["reference"],
                    "before": before,
                    "after": {
                        "name": chain["name"],
                        "color": chain["color"],
                        "colorIndex": chain["colorIndex"],
                    },
                    "verified": True,
                },
            )
        before = state.chain_mixer_summary(chain)
        if "mute" in params:
            chain["mute"] = params["mute"]
        if "solo" in params:
            chain["solo"] = params["solo"]
        for name in ("volume", "pan"):
            if name in params:
                parameter = chain["mixer"][name]
                change = params[name]
                if (
                    parameter["reference"]
                    != change["expectedParameterReference"]
                    or parameter["name"] != change["expectedParameterName"]
                ):
                    return failure(
                        request,
                        "stale_reference",
                        "Chain mixer parameter identity changed",
                    )
                parameter["value"] = (
                    parameter["min"]
                    + (parameter["max"] - parameter["min"])
                    * change["normalizedValue"]
                )
        for change in params.get("sends", []):
            if change["index"] >= len(chain["mixer"]["sends"]):
                return failure(
                    request, "not_found", "Chain send index is out of range"
                )
            parameter = chain["mixer"]["sends"][change["index"]]
            if (
                parameter["reference"] != change["expectedParameterReference"]
                or parameter["name"] != change["expectedParameterName"]
            ):
                return failure(
                    request,
                    "stale_reference",
                    "Chain send identity changed",
                )
            parameter["value"] = change["normalizedValue"]
        after = state.chain_mixer_summary(chain)
        return response(
            request,
            {
                "chainReference": chain["reference"],
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
        state.publish_live_event_changes()
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
    if command in (
        "clips.create_midi",
        "clips.inspect_notes",
        "clips.replace_notes",
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
        if command == "clips.inspect_notes":
            offset = params.get("offset", 0)
            limit = params.get("limit", 256)
            notes = sorted(
                clip["notes"],
                key=lambda note: (
                    note["startTime"],
                    note["pitch"],
                    note["duration"],
                ),
            )
            selected = notes[offset : offset + limit]
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
                        "noteCount": len(notes),
                    },
                    "notes": selected,
                    "totalNotes": len(notes),
                    "offset": offset,
                    "limit": limit,
                    "truncated": offset + len(selected) < len(notes),
                },
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
            track["firedSceneIndex"] = scene_index
            state.publish_live_event_changes()
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
                "clips": [
                    {
                        key: value
                        for key, value in clip.items()
                        if key != "notes"
                    }
                    for clip in clips[offset : offset + limit]
                ],
                "total": len(clips),
                "offset": offset,
                "limit": limit,
            },
        )
    if command == "arrangement.inspect_notes":
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
                "Track identity changed before inspection",
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
                "Arrangement clip changed before note inspection",
            )
        if target["kind"] != "midi":
            return failure(
                request, "conflict", "Arrangement clip is not a MIDI clip"
            )
        notes = sorted(
            target.get("notes", []),
            key=lambda note: (
                note["startTime"],
                note["pitch"],
                note["duration"],
            ),
        )
        offset = params.get("offset", 0)
        limit = params.get("limit", 256)
        selected = notes[offset : offset + limit]
        return response(
            request,
            {
                "clip": {
                    key: value
                    for key, value in target.items()
                    if key != "notes"
                },
                "notes": selected,
                "totalNotes": len(notes),
                "offset": offset,
                "limit": limit,
                "truncated": offset + len(selected) < len(notes),
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


def serve(
    host,
    port,
    token,
    connections=1,
    delay_command=None,
    delay_ms=0,
):
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
                        if (
                            delay_command is not None
                            and request.get("command") == delay_command
                        ):
                            time.sleep(delay_ms / 1000.0)
                        result = handle(request, token, state)
                        if result is not None:
                            connection.sendall(encode_frame(result))
                        while state.live_event_messages:
                            connection.sendall(
                                encode_frame(
                                    state.live_event_messages.popleft()
                                )
                            )
            finally:
                state.live_event_subscriptions = {}
                state.live_event_messages.clear()
                connection.close()
    finally:
        server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    parser.add_argument("--connections", type=int, default=1)
    parser.add_argument("--delay-command")
    parser.add_argument("--delay-ms", type=int, default=0)
    args = parser.parse_args()
    if args.connections < 1:
        parser.error("--connections must be at least 1")
    if args.delay_ms < 0:
        parser.error("--delay-ms must be non-negative")
    serve(
        args.host,
        args.port,
        args.token,
        args.connections,
        args.delay_command,
        args.delay_ms,
    )


if __name__ == "__main__":
    main()
