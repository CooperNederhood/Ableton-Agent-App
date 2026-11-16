"""Read-only saved-fixture checks; never opens Live or follows saved references."""

import argparse
import copy
import gzip
import hashlib
import json
import struct
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
ORIGINAL_SHA256 = "2598679f4044b75e09ecb9c0105214f2c2d3b36754ea21036646bac0880c9ef5"
SESSION_PATH = "DeviceChain/MainSequencer/ClipSlotList/ClipSlot/ClipSlot/Value/*"
MIDI_PATH = "DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip"
AUDIO_PATH = "DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path):
    if path.is_symlink() or path.resolve() != path.absolute() or not path.is_file():
        raise ValueError(f"Non-regular or linked fixture resource: {path.name}")
    return path.read_bytes()


def saved_xml(data):
    if not 0 < len(data) <= 8 * 1024 * 1024:
        raise ValueError("Set input bound")
    xml = gzip.decompress(data)
    if len(xml) > 16 * 1024 * 1024 or any(
        marker in xml for marker in (b"<!DOCTYPE", b"<!ENTITY", b"<![CDATA[")
    ):
        raise ValueError("Unsupported Set XML")
    return ET.fromstring(xml)


def value(element, path):
    result = element.find(path)
    return None if result is None else result.get("Value")


def number(text):
    result = float(text)
    return int(result) if result.is_integer() else result


def canonical_hash(data):
    return sha256(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode())


def midi_notes(clip, offset=0):
    notes = []
    for key in clip.findall("Notes/KeyTracks/KeyTrack"):
        pitch = int(value(key, "MidiKey"))
        for event in key.findall("Notes/MidiNoteEvent"):
            attributes = dict(event.attrib)
            attributes.pop("NoteId")
            attributes["Time"] = str(number(attributes["Time"]) + offset)
            notes.append({"pitch": pitch, **attributes})
    return sorted(notes, key=lambda note: (
        note["pitch"], float(note["Time"]), float(note["Duration"]),
        float(note["Velocity"]), json.dumps(note, sort_keys=True),
    ))


def protocol_notes_hash(notes):
    tuples = sorted([
        [note["pitch"], number(note["Time"]), number(note["Duration"]),
         number(note["Velocity"]), note["IsEnabled"] != "true"]
        for note in notes
    ])
    return canonical_hash(tuples)


def clip_reference(clip):
    fields = [
        "CurrentStart", "CurrentEnd", "Loop/LoopStart", "Loop/LoopEnd",
        "Loop/StartRelative", "Loop/LoopOn", "Loop/OutMarker", "LaunchMode",
        "LaunchQuantisation", "Legato", "FollowAction/FollowActionEnabled",
        "IsWarped", "WarpMode", "SampleVolume", "PitchCoarse", "PitchFine",
        "SampleRef/DefaultDuration", "SampleRef/DefaultSampleRate",
    ]
    result = {
        "kind": clip.tag,
        "savedClipId": clip.get("Id"),
        "savedTime": clip.get("Time"),
        "name": value(clip, "Name"),
        "settings": {key: value(clip, key) for key in fields if clip.find(key) is not None},
    }
    if clip.tag == "MidiClip":
        notes = midi_notes(clip)
        result.update(
            noteCount=len(notes),
            savedNotesExcludingNoteIdSha256=canonical_hash(notes),
            protocolNotesSha256=protocol_notes_hash(notes),
        )
    else:
        result["mediaTarget"] = value(clip, "SampleRef/FileRef/RelativePath")
        for tag in ("WarpMarkers", "Fades", "Onsets"):
            element = clip.find(tag)
            if element is not None:
                result[f"saved{tag}Sha256"] = sha256(ET.tostring(element))
    return result


def aiff_header(data):
    if data[:4] != b"FORM" or data[8:12] != b"AIFF":
        raise ValueError("Expected original AIFF")
    cursor = 12
    while cursor + 8 <= len(data):
        size = int.from_bytes(data[cursor + 4:cursor + 8], "big")
        if data[cursor:cursor + 4] == b"COMM":
            channels, frames, bits = struct.unpack(">hIh", data[cursor + 8:cursor + 16])
            exponent = int.from_bytes(data[cursor + 16:cursor + 18], "big")
            mantissa = int.from_bytes(data[cursor + 18:cursor + 26], "big")
            rate = int(mantissa * 2 ** (exponent - 16383 - 63))
            return {"channels": channels, "frames": frames, "bits": bits, "sampleRate": rate}
        cursor += 8 + size + size % 2
    raise ValueError("Missing AIFF COMM")


def build_saved_reference(data):
    root = saved_xml(data)
    tracks = root.findall("LiveSet/Tracks/*")
    result = {
        "creator": root.get("Creator"),
        "savedTransportBeat": value(root, "LiveSet/Transport/CurrentTime"),
        "savedTransportLoopOn": value(root, "LiveSet/Transport/LoopOn"),
        "savedGlobalQuantisationOrdinal": value(root, "LiveSet/GlobalQuantisation"),
        "savedTempoBpm": value(root, "LiveSet/MasterTrack/DeviceChain/Mixer/Tempo/Manual"),
        "tracks": [],
    }
    for index, track in enumerate(tracks):
        result["tracks"].append({
            "index": index,
            "kind": track.tag,
            "savedTrackId": track.get("Id"),
            "name": value(track, "Name/EffectiveName"),
            "topLevelDevices": [
                {"index": i, "class": device.tag, "savedDeviceId": device.get("Id")}
                for i, device in enumerate(track.findall("DeviceChain/DeviceChain/Devices/*"))
            ],
            "session": [
                {"sceneIndex": i, **clip_reference(clip)}
                for i, slot in enumerate(track.findall(
                    "DeviceChain/MainSequencer/ClipSlotList/ClipSlot"
                ))
                for clip in slot.findall("ClipSlot/Value/*")
            ],
            "arrangement": [
                clip_reference(clip)
                for clip in track.findall(MIDI_PATH) + track.findall(AUDIO_PATH)
            ],
        })
    midi_track = tracks[0]
    sessions = midi_track.findall(SESSION_PATH)
    arrangement = midi_track.findall(MIDI_PATH)
    long_notes = sorted(
        [note for clip in arrangement for note in midi_notes(
            clip, number(value(clip, "CurrentStart"))
        )],
        key=lambda note: (
            note["pitch"], float(note["Time"]), float(note["Duration"]),
            float(note["Velocity"]), json.dumps(note, sort_keys=True),
        ),
    )
    if midi_notes(sessions[0]) != midi_notes(arrangement[0]):
        raise ValueError("Saved short MIDI differs")
    if midi_notes(sessions[4]) != long_notes:
        raise ValueError("Saved long MIDI differs")
    result["midiParity"] = {
        "shortNoteCount": len(midi_notes(sessions[0])),
        "longNoteCount": len(long_notes),
        "excludedField": "NoteId",
        "includes": "Every other saved MidiNoteEvent attribute and pitch; Arrangement time translated to beats from zero",
    }
    return result


def verify_fixture(directory=ROOT, intake=None):
    manifest = json.loads(read_regular(directory / "fixture.json"))
    reference = json.loads(read_regular(directory / "offline-reference.json"))
    for resource in manifest["resources"]:
        data = read_regular(directory / resource["path"])
        if len(data) != resource["bytes"] or sha256(data) != resource["sha256"]:
            raise ValueError(f"Changed resource: {resource['path']}")
        if resource["path"].endswith(".aif"):
            if aiff_header(data) != reference["audioHeaders"][resource["target"]]:
                raise ValueError("Changed audio header")
    project = read_regular(directory / "project.als")
    if (reference["originalSetSha256"] != ORIGINAL_SHA256
            or reference["portableSetSha256"] != sha256(project)
            or reference["qualificationScope"] != "storage-shape-and-count"
            or reference["numericalEquivalence"] != "deferred"):
        raise ValueError("Offline provenance/admission reference differs")
    reviews = reference["loadedReviews"]
    reviewed_sessions = {source for review in reviews for source in review["sessionSourceIds"]}
    reviewed_arrangement = {source for review in reviews for source in review["arrangementSourceIds"]}
    if (manifest["qualification"] != "reviewed-live"
            or len(reviews) != 3
            or {review["runId"] for review in reviews} != {
                "b3b0c521-b40e-4b90-beb0-d6c50affc631",
                "88369718-bd7e-4275-be71-f0accd616d5d",
                "a7b40c03-0ff0-4237-a27c-3df84c365b33",
            }
            or any(review["status"] != "reviewed-source-admission"
                   or review["liveVersion"] != "11.3.43" for review in reviews)
            or reviewed_sessions != {source["id"] for source in manifest["sources"]}
            or reviewed_arrangement != {source["id"] for source in manifest["arrangementSources"]}):
        raise ValueError("Loaded source-review metadata differs")
    if build_saved_reference(project) != reference["saved"]:
        raise ValueError("Saved identity/settings reference differs")
    if intake is not None:
        original = read_regular(intake)
        if sha256(original) != ORIGINAL_SHA256:
            raise ValueError("Wrong immutable intake")
        original_xml = gzip.decompress(original).decode()
        portable_xml = gzip.decompress(project).decode()
        for relocation in reference["audioRelocations"]:
            old, new = relocation["originalFileRef"], relocation["portableFileRef"]
            if original_xml.count(old) != relocation["occurrences"]:
                raise ValueError("Relocation source count differs")
            original_xml = original_xml.replace(old, new)
        if original_xml != portable_xml:
            raise ValueError("Non-reviewed XML change")
    return {
        "status": "verified-offline-assets",
        "resources": len(manifest["resources"]),
        "midiParity": reference["saved"]["midiParity"],
        "loadedReview": "recorded-source-admission-not-reexecuted",
        "captureQualification": False,
    }


class FixtureRegressionTests(unittest.TestCase):
    def test_exact_assets_saved_identity_and_parity(self):
        self.assertEqual(verify_fixture()["resources"], 6)

    def test_changed_midi_note_rejected(self):
        data = read_regular(ROOT / "project.als")
        root = saved_xml(data)
        note = root.find(f"LiveSet/Tracks/MidiTrack/{SESSION_PATH}/Notes/KeyTracks/KeyTrack/Notes/MidiNoteEvent")
        self.assertIsNotNone(note)
        note.set("Velocity", "99")
        with self.assertRaisesRegex(ValueError, "short MIDI differs"):
            build_saved_reference(gzip.compress(ET.tostring(root)))

    def test_note_ids_are_not_musical_identity(self):
        root = saved_xml(read_regular(ROOT / "project.als"))
        original = copy.deepcopy(root)
        for note in root.findall(".//MidiNoteEvent"):
            note.set("NoteId", str(int(note.get("NoteId")) + 1000))
        self.assertEqual(build_saved_reference(gzip.compress(ET.tostring(root))),
                         build_saved_reference(gzip.compress(ET.tostring(original))))

    def test_changed_long_arrangement_note_rejected(self):
        root = saved_xml(read_regular(ROOT / "project.als"))
        clip = root.findall(f"LiveSet/Tracks/MidiTrack/{MIDI_PATH}")[-1]
        clip.find("Notes/KeyTracks/KeyTrack/Notes/MidiNoteEvent").set("Time", "0.125")
        with self.assertRaisesRegex(ValueError, "long MIDI differs"):
            build_saved_reference(gzip.compress(ET.tostring(root)))

    def test_changed_audio_bytes_rejected(self):
        original_read = read_regular

        def changed_audio(path):
            data = original_read(path)
            return data[:-1] + bytes([data[-1] ^ 1]) if path.suffix == ".aif" else data

        with patch(f"{__name__}.read_regular", side_effect=changed_audio):
            with self.assertRaisesRegex(ValueError, "Changed resource"):
                verify_fixture()

    def test_changed_saved_reference_rejected(self):
        original_read = read_regular

        def changed_reference(path):
            data = original_read(path)
            if path.name == "offline-reference.json":
                reference = json.loads(data)
                reference["saved"]["savedTransportBeat"] = "0"
                return json.dumps(reference).encode()
            return data

        with patch(f"{__name__}.read_regular", side_effect=changed_reference):
            with self.assertRaisesRegex(ValueError, "Saved identity/settings reference differs"):
                verify_fixture()

    def test_incomplete_review_inventory_rejected(self):
        original_read = read_regular

        for index, kind in ((0, "sessionSourceIds"), (2, "arrangementSourceIds")):
            with self.subTest(review=index, source=kind):
                def changed_reference(path):
                    data = original_read(path)
                    if path.name == "offline-reference.json":
                        reference = json.loads(data)
                        reference["loadedReviews"][index][kind].pop()
                        return json.dumps(reference).encode()
                    return data

                with patch(f"{__name__}.read_regular", side_effect=changed_reference):
                    with self.assertRaisesRegex(ValueError, "Loaded source-review metadata differs"):
                        verify_fixture()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intake-set", type=Path, help="Optional owned intake; never the original project")
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    if args.test:
        unittest.main(argv=[__file__])
    else:
        print(json.dumps(verify_fixture(intake=args.intake_set), indent=2))
