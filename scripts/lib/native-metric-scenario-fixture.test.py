import gzip
import importlib.util
import io
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid
import wave
import xml.etree.ElementTree as ET


spec = importlib.util.spec_from_file_location(
    "fixture", Path(__file__).with_name("native-metric-scenario-fixture.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def xml_fixture():
    root = ET.Element("Ableton", Creator="Ableton Live 11.3.43")
    tempo = ET.SubElement(root, "Tempo")
    ET.SubElement(tempo, "Manual", Value="120")
    ET.SubElement(tempo, "AutomationTarget", Id="8")
    envelope = ET.SubElement(root, "AutomationEnvelope")
    target = ET.SubElement(envelope, "EnvelopeTarget")
    ET.SubElement(target, "PointeeId", Value="8")
    automation = ET.SubElement(envelope, "Automation")
    events = ET.SubElement(automation, "Events")
    ET.SubElement(events, "FloatEvent", Time="-63072000", Value="120")
    for kind, name in [("MidiClip", "AA_SESSION_MIDI_8BEATS"),
                       ("AudioClip", "AA_SESSION_120BPM_8BEATS")]:
        clip = ET.SubElement(root, kind)
        for tag, value in [("Name", name), ("CurrentStart", 0), ("CurrentEnd", 8),
                           ("LaunchMode", 0), ("LaunchQuantisation", 0), ("Legato", "false")]:
            ET.SubElement(clip, tag, Value=str(value))
        loop = ET.SubElement(clip, "Loop")
        for tag, value in [("LoopStart", 0), ("StartRelative", 0), ("LoopEnd", 8),
                           ("OutMarker", 8), ("HiddenLoopEnd", 8)]:
            ET.SubElement(loop, tag, Value=str(value))
        follow = ET.SubElement(clip, "FollowAction")
        ET.SubElement(follow, "FollowActionEnabled", Value="false")
        if kind == "MidiClip":
            notes = ET.SubElement(clip, "Notes")
            keys = ET.SubElement(notes, "KeyTracks")
            for i in range(4):
                key = ET.SubElement(keys, "KeyTrack")
                track_notes = ET.SubElement(key, "Notes")
                ET.SubElement(track_notes, "MidiNoteEvent", Time=str(i + 0.5),
                              Duration="0.75", Velocity="90", NoteId=str(i + 1))
            generator = ET.SubElement(notes, "NoteIdGenerator")
            ET.SubElement(generator, "NextId", Value="5")
        else:
            sample = ET.SubElement(clip, "SampleRef")
            ET.SubElement(sample, "DefaultDuration", Value="192000")
            ET.SubElement(sample, "DefaultSampleRate", Value="48000")
            ET.SubElement(clip, "WarpMarkers")
    return root


def audio_fixture():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x10\x00\x10\x00" * 192000)
    return buffer.getvalue()


class LongMetricPreparationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path.cwd() / ".test-artifacts" / f"long-preparation-unit-{uuid.uuid4()}"
        self.root.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_exact_unlooped_midi_content_and_warped_pcm_duration(self):
        original = ET.tostring(xml_fixture())
        transformed = fixture.transform_set(original, self.root / "candidate/device.amxd",
                                            self.root / "audio.wav", 6144044)
        result = ET.fromstring(transformed)
        self.assertEqual(result.find(".//Tempo/Manual").get("Value"), "128")
        self.assertEqual(result.find(".//FloatEvent").get("Value"), "128")
        notes = result.findall(".//MidiNoteEvent")
        self.assertEqual(len(notes), 64)
        self.assertEqual(len({note.get("NoteId") for note in notes}), 64)
        self.assertEqual(max(float(n.get("Time")) + float(n.get("Duration")) for n in notes), 64)
        self.assertEqual(result.find(".//AudioClip/Loop/LoopEnd").get("Value"), "64")
        self.assertEqual(result.find(".//AudioClip/SampleRef/DefaultDuration").get("Value"), "1536000")
        self.assertEqual(result.findall(".//WarpMarker")[1].attrib,
                         {"Id": "1", "SecTime": "32", "BeatTime": "64"})
        extended = fixture.extend_audio(audio_fixture())
        with wave.open(io.BytesIO(extended), "rb") as audio:
            self.assertEqual(audio.getnframes(), 1536000)
            self.assertEqual(audio.getframerate(), 48000)
            self.assertEqual(audio.readframes(1), b"\x10\x00\x10\x00")
        # The prepared 32-second source at warp120 plays 64beats/30seconds at Set128.
        self.assertEqual(64 * 60 / 128, 30)
        self.assertEqual(ET.fromstring(original).find(".//Tempo/Manual").get("Value"), "120")

    def test_rejects_source_repairs_and_dynamic_tempo_automation(self):
        for mutation in ["loop-origin", "legato", "follow", "tempo", "duplicate", "live12"]:
            with self.subTest(mutation=mutation):
                root = xml_fixture()
                if mutation == "loop-origin":
                    root.find(".//MidiClip/Loop/StartRelative").set("Value", "1")
                elif mutation == "legato":
                    root.find(".//MidiClip/Legato").set("Value", "true")
                elif mutation == "follow":
                    root.find(".//MidiClip/FollowAction/FollowActionEnabled").set("Value", "true")
                elif mutation == "tempo":
                    ET.SubElement(root.find(".//Events"), "FloatEvent", Time="4", Value="125")
                elif mutation == "duplicate":
                    root.append(ET.fromstring(ET.tostring(root.find(".//MidiClip"))))
                else:
                    root.set("Creator", "Ableton Live 12.0")
                with self.assertRaises(ValueError):
                    fixture.transform_set(ET.tostring(root), self.root / "c/d.amxd",
                                          self.root / "a.wav", 6144044)

    def synthetic_inputs(self):
        original = gzip.compress(ET.tostring(xml_fixture()), mtime=0)
        audio = audio_fixture()
        (self.root / "source.als").write_bytes(original)
        (self.root / "audio.wav").write_bytes(audio)
        candidate_dir = self.root / "candidate"
        candidate_dir.mkdir()
        device = b"unit test only; not an actual playable device"
        (candidate_dir / "device.amxd").write_bytes(device)
        manifest = {
            "nativeVersion": 5, "nativeMode": True, "realLiveValidated": False,
            "externalAuthoringBridge": False, "deviceFile": "device.amxd",
            "deviceSha256": fixture.digest(device), "resources": [],
        }
        manifest_bytes = json.dumps(manifest).encode()
        (candidate_dir / "audio-listener-manifest.json").write_bytes(manifest_bytes)
        source = {
            "formatVersion": 1, "nativeVersion": 4,
            "sourceSet": str(self.root / "source.als"), "sourceSetSha256": fixture.digest(original),
            "audioFiles": [{"path": str(self.root / "audio.wav"), "sha256": fixture.digest(audio)}],
        }
        candidate = {
            "nativeVersion": 5, "candidateDirectory": str(candidate_dir),
            "candidateManifestSha256": fixture.digest(manifest_bytes),
            "deviceFile": "device.amxd", "deviceSha256": fixture.digest(device),
        }
        source_path = self.root / "source-input.json"
        candidate_path = self.root / "candidate-input.json"
        source_path.write_text(json.dumps(source))
        candidate_path.write_text(json.dumps(candidate))
        return source, candidate, source_path, candidate_path, original, audio

    def test_success_is_copied_hash_pinned_immutable_and_never_overwrites(self):
        source, candidate, source_path, candidate_path, original, audio = self.synthetic_inputs()
        with patch.object(fixture, "SET_HASH", fixture.digest(original)), \
                patch.object(fixture, "AUDIO_HASH", fixture.digest(audio)):
            result = fixture.prepare(source_path, candidate_path, self.root / "prepared")
            output = json.loads(Path(result["inputPath"]).read_text())
            self.assertFalse(result["physicalQualification"])
            self.assertEqual(output["sourceSetSha256"],
                             fixture.digest(Path(output["sourceSet"]).read_bytes()))
            self.assertEqual(output["audioFiles"][0]["sha256"],
                             fixture.digest(Path(output["audioFiles"][0]["path"]).read_bytes()))
            self.assertEqual(Path(source["sourceSet"]).read_bytes(), original)
            self.assertEqual(Path(source["audioFiles"][0]["path"]).read_bytes(), audio)
            self.assertEqual(output["nativeVersion"], 5)
            self.assertEqual(output["candidateManifestSha256"], candidate["candidateManifestSha256"])
            with self.assertRaises(ValueError):
                fixture.prepare(source_path, candidate_path, self.root / "prepared")
        self.assertTrue(Path(result["inputPath"]).exists())

    def test_first_failure_cleans_only_new_destination_and_never_retries(self):
        _, _, source_path, candidate_path, original, audio = self.synthetic_inputs()
        destination = self.root / "prepared"
        with patch.object(fixture, "SET_HASH", fixture.digest(original)), \
                patch.object(fixture, "AUDIO_HASH", fixture.digest(audio)), \
                patch.object(fixture, "transform_set", side_effect=RuntimeError("controlled failure")) as transform:
            with self.assertRaisesRegex(RuntimeError, "controlled failure"):
                fixture.prepare(source_path, candidate_path, destination)
            transform.assert_called_once()
        self.assertFalse(destination.exists())
        self.assertEqual((self.root / "source.als").read_bytes(), original)
        self.assertEqual((self.root / "audio.wav").read_bytes(), audio)

    def test_cancellation_cleans_new_destination_but_preserves_originals(self):
        _, _, source_path, candidate_path, original, audio = self.synthetic_inputs()
        destination = self.root / "prepared"
        with patch.object(fixture, "SET_HASH", fixture.digest(original)), \
                patch.object(fixture, "AUDIO_HASH", fixture.digest(audio)), \
                patch.object(fixture, "transform_set", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                fixture.prepare(source_path, candidate_path, destination)
        self.assertFalse(destination.exists())
        self.assertEqual((self.root / "source.als").read_bytes(), original)

    def test_rejects_unpinned_source_and_symlink_inputs_without_output(self):
        _, _, source_path, candidate_path, original, audio = self.synthetic_inputs()
        destination = self.root / "prepared"
        with self.assertRaisesRegex(ValueError, "Canonical source pins"):
            fixture.prepare(source_path, candidate_path, destination)
        self.assertFalse(destination.exists())
        link = self.root / "linked-input.json"
        link.symlink_to(source_path)
        with self.assertRaisesRegex(ValueError, "nonsymlink"):
            fixture.bounded_file(link)
        with patch.object(fixture, "SET_HASH", fixture.digest(original)), \
                patch.object(fixture, "AUDIO_HASH", fixture.digest(audio)):
            candidate = json.loads(candidate_path.read_text())
            candidate["engineeringFixture"] = {"id": "native5-unavailable-spectrum/v1"}
            candidate_path.write_text(json.dumps(candidate))
            with self.assertRaisesRegex(ValueError, "Default native5"):
                fixture.prepare(source_path, candidate_path, destination)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
