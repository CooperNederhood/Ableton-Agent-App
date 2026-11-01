"""Offline preparation of the reviewed copied native5 long-capture fixture.

No Live process, profile, installation, or original Set is mutated.
"""

import argparse
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import wave
import xml.etree.ElementTree as ET


SET_HASH = "089a2dc15d61b685b035672b58cc81ccfb81d0f97471ea2d10efe168390c9fcb"
AUDIO_HASH = "1bae0212d0f4b0f7ed18d0d9a97dbd008145559e8c28586d415b659329a0012c"
MIDI_NAME = "AA_METRIC_MIDI_64BEATS"
AUDIO_NAME = "AA_METRIC_AUDIO_64BEATS"


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bounded_file(path, maximum=8 * 1024 * 1024):
    path = Path(path).absolute()
    root = Path.cwd() / ".test-artifacts"
    require(path.is_relative_to(root), "Inputs must be harness-owned .test-artifacts files")
    require(path.resolve() == path and path.is_file() and not path.is_symlink(),
            "Bounded nonsymlink regular input required")
    require(0 < path.stat().st_size <= maximum, "Input size quota exceeded")
    data = path.read_bytes()
    require(len(data) == path.stat().st_size, "Input changed during read")
    return data


def transform_set(xml, candidate_path, audio_path, audio_bytes):
    require(len(xml) <= 16 * 1024 * 1024 and
            not re.search(br"<!DOCTYPE|<!ENTITY", xml, re.I), "Unsupported Set XML")
    root = ET.fromstring(xml)
    require(root.get("Creator", "").startswith("Ableton Live 11."), "Live11 fixture required")
    midi = [c for c in root.findall(".//MidiClip")
            if c.find("Name").get("Value") == "AA_SESSION_MIDI_8BEATS"]
    audio = [c for c in root.findall(".//AudioClip")
             if c.find("Name").get("Value") == "AA_SESSION_120BPM_8BEATS"]
    require(len(midi) == len(audio) == 1, "Exact canonical Session source pair required")
    tempo = root.findall(".//Tempo/Manual")
    require(len(tempo) == 1 and tempo[0].get("Value") == "120", "Constant120 base tempo required")
    tempo[0].set("Value", "128")
    # Live serializes a single negative-time baseline even with no tempo automation.
    tempo_target = root.find(".//Tempo/AutomationTarget").get("Id")
    for envelope in root.findall(".//AutomationEnvelope"):
        target = envelope.find("EnvelopeTarget/PointeeId")
        if target is not None and target.get("Value") == tempo_target:
            events = envelope.findall("Automation/Events/FloatEvent")
            require(len(events) == 1 and events[0].get("Value") == "120" and
                    float(events[0].get("Time")) < 0,
                    "Tempo automation is unsupported")
            events[0].set("Value", "128")
    for clip, name in [(midi[0], MIDI_NAME), (audio[0], AUDIO_NAME)]:
        for path in ["CurrentStart", "Loop/LoopStart", "Loop/StartRelative"]:
            require(clip.find(path).get("Value") == "0", "First-iteration origin must be zero")
        for path in ["CurrentEnd", "Loop/LoopEnd", "Loop/OutMarker", "Loop/HiddenLoopEnd"]:
            clip.find(path).set("Value", "64")
        clip.find("Name").set("Value", name)
        require(clip.find("LaunchMode").get("Value") == "0" and
                clip.find("LaunchQuantisation").get("Value") == "0" and
                clip.find("Legato").get("Value") == "false" and
                clip.find("FollowAction/FollowActionEnabled").get("Value") == "false",
                "Unquantized nonlegato source without follow actions required")
    next_id = 1
    keys = midi[0].findall("Notes/KeyTracks/KeyTrack")
    require(len(keys) == 4, "Exact four-note Operator motif required")
    for key in keys:
        notes = key.find("Notes")
        original = list(notes)
        require(len(original) == 1, "Exact single note per motif key required")
        start = float(original[0].get("Time"))
        duration = float(original[0].get("Duration"))
        notes.remove(original[0])
        for repeat in range(16):
            note = copy.deepcopy(original[0])
            position = start + repeat * 4
            note.set("Time", str(position))
            note.set("Duration", str(min(duration, 64 - position)))
            note.set("NoteId", str(next_id))
            next_id += 1
            notes.append(note)
    midi[0].find("Notes/NoteIdGenerator/NextId").set("Value", str(next_id))
    sample = audio[0].find("SampleRef")
    sample.find("DefaultDuration").set("Value", "1536000")
    sample.find("DefaultSampleRate").set("Value", "48000")
    markers = audio[0].find("WarpMarkers")
    markers.clear()
    for index, (seconds, beats) in enumerate([(0, 0), (32, 64), (32.015625, 64.03125)]):
        ET.SubElement(markers, "WarpMarker", Id=str(index),
                      SecTime=str(seconds), BeatTime=str(beats))
    for ref in root.findall(".//FileRef"):
        path = ref.find("Path")
        if path is None:
            continue
        old = path.get("Value")
        if old.endswith(".amxd"):
            path.set("Value", str(candidate_path))
            ref.find("RelativePath").set("Value", f"{candidate_path.parent.name}/{candidate_path.name}")
            ref.find("RelativePathType").set("Value", "3")
        elif old.endswith(".wav"):
            path.set("Value", str(audio_path))
            ref.find("RelativePath").set("Value", "Samples/Imported/AA_METRIC_AUDIO_64BEATS.wav")
            ref.find("RelativePathType").set("Value", "3")
            for tag, value in [("OriginalFileSize", audio_bytes), ("OriginalCrc", 0)]:
                element = ref.find(tag)
                if element is not None:
                    element.set("Value", str(value))
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def extend_audio(data):
    with wave.open(io.BytesIO(data), "rb") as source:
        require(source.getparams()[:4] == (2, 2, 48000, 192000),
                "Pinned stereo PCM16 48kHz four-second audio required")
        frames = source.readframes(192000)
    output = io.BytesIO()
    with wave.open(output, "wb") as destination:
        destination.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        destination.writeframes(frames * 8)
    return output.getvalue()


def prepare(source_input, candidate_input, destination):
    source = json.loads(bounded_file(source_input, 65536))
    candidate = json.loads(bounded_file(candidate_input, 65536))
    require(source["sourceSetSha256"] == SET_HASH and
            len(source["audioFiles"]) == 1 and
            source["audioFiles"][0]["sha256"] == AUDIO_HASH, "Canonical source pins required")
    set_bytes = bounded_file(source["sourceSet"])
    audio_bytes = bounded_file(source["audioFiles"][0]["path"])
    require(digest(set_bytes) == SET_HASH and digest(audio_bytes) == AUDIO_HASH,
            "Canonical source hash mismatch")
    require(candidate["nativeVersion"] == 5 and "engineeringFixture" not in candidate,
            "Default native5 candidate required; no engineering variant")
    manifest_bytes = bounded_file(Path(candidate["candidateDirectory"]) / "audio-listener-manifest.json", 65536)
    manifest = json.loads(manifest_bytes)
    require(digest(manifest_bytes) == candidate["candidateManifestSha256"] and
            manifest["nativeVersion"] == 5 and manifest["nativeMode"] is True and
            manifest["realLiveValidated"] is False and
            manifest["externalAuthoringBridge"] is False and
            manifest["deviceSha256"] == candidate["deviceSha256"] and
            manifest["deviceFile"] == candidate["deviceFile"] and
            "engineeringFixture" not in manifest, "Candidate manifest binding mismatch")
    directory = Path(candidate["candidateDirectory"]).absolute()
    names = list(directory.iterdir())
    pins = {r["name"]: r["sha256"] for r in manifest["resources"]}
    pins[candidate["deviceFile"]] = candidate["deviceSha256"]
    require(len(names) <= 64 and set(pins).issubset({p.name for p in names}),
            "Candidate resources missing or quota exceeded")
    snapshots = {}
    for path in names:
        require(re.fullmatch(r"[A-Za-z0-9_.-]+", path.name), "Unsafe candidate resource name")
        data = bounded_file(path, 2 * 1024 * 1024)
        require(path.name in pins or path.name in
                ["audio-listener-manifest.json", "agent_signal_storage.js"], "Unreviewed candidate resource")
        require(path.name not in pins or digest(data) == pins[path.name], "Candidate resource hash mismatch")
        snapshots[path.name] = data
    destination = Path(destination).absolute()
    artifact_root = Path.cwd() / ".test-artifacts"
    require(destination.is_relative_to(artifact_root) and destination != artifact_root and
            not destination.exists() and not destination.is_symlink() and
            destination.parent.resolve() == destination.parent and destination.parent.is_dir(),
            "Fresh nonsymlink .test-artifacts destination with existing parent required")
    destination.mkdir(mode=0o700)
    try:
        copied_candidate = destination / "LongListener-native5"
        copied_candidate.mkdir(mode=0o700)
        for name, data in snapshots.items():
            (copied_candidate / name).write_bytes(data)
        copied_audio = destination / "Samples/Imported/AA_METRIC_AUDIO_64BEATS.wav"
        copied_audio.parent.mkdir(parents=True)
        extended = extend_audio(audio_bytes)
        copied_audio.write_bytes(extended)
        with gzip.GzipFile(fileobj=io.BytesIO(set_bytes), mode="rb") as stream:
            xml = stream.read(16 * 1024 * 1024 + 1)
        transformed = transform_set(xml, copied_candidate / candidate["deviceFile"],
                                    copied_audio, len(extended))
        copied_set = destination / "LongMetric-Prepared.als"
        prepared = gzip.compress(transformed, mtime=0)
        copied_set.write_bytes(prepared)
        result = {
            **source,
            "nativeVersion": 5,
            "sourceSet": str(copied_set),
            "sourceSetSha256": digest(prepared),
            "candidateDirectory": str(copied_candidate),
            "candidateManifestSha256": candidate["candidateManifestSha256"],
            "deviceFile": candidate["deviceFile"],
            "deviceSha256": candidate["deviceSha256"],
            "artifactPrefix": "AA_SMOKE_METRIC_LONG_",
            "audioFiles": [{"path": str(copied_audio), "sha256": digest(extended)}],
            "longMetricFixture": {
                "schema": "native-metric-long-fixture/v1",
                "tempoBpm": 128, "signatureNumerator": 4, "signatureDenominator": 4,
                "firstIterationEndBeat": 64, "midiClipName": MIDI_NAME, "audioClipName": AUDIO_NAME,
                "audioSampleRate": 48000, "audioSampleLength": 1536000,
                "sourceSetSha256": SET_HASH, "sourceAudioSha256": AUDIO_HASH,
                "preparedSetSha256": digest(prepared), "preparedAudioSha256": digest(extended),
            },
        }
        input_path = destination / "input.json"
        input_path.write_text(json.dumps(result, indent=2) + "\n")
        require(bounded_file(source["sourceSet"]) == set_bytes and
                bounded_file(source["audioFiles"][0]["path"]) == audio_bytes,
                "Original inputs changed during preparation")
        return {"inputPath": str(input_path), "physicalQualification": False,
                "sourceSetSha256": digest(prepared), "audioSha256": digest(extended)}
    except BaseException:
        shutil.rmtree(destination)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-input", required=True)
    parser.add_argument("--candidate-input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source_input, args.candidate_input, args.out), indent=2))
