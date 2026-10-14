{
  "patcher": {
    "fileversion": 1,
    "classnamespace": "box",
    "rect": [
      0,
      0,
      800,
      380
    ],
    "boxes": [
      {
        "box": {
          "id": "command",
          "text": "in 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            10,
            50,
            22
          ],
          "varname": "ml_synced_command"
        }
      },
      {
        "box": {
          "id": "left",
          "text": "in~ 2",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            150,
            10,
            50,
            22
          ],
          "varname": "ml_synced_left"
        }
      },
      {
        "box": {
          "id": "right",
          "text": "in~ 3",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            250,
            10,
            50,
            22
          ],
          "varname": "ml_synced_right"
        }
      },
      {
        "box": {
          "id": "clock",
          "text": "in~ 4",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            350,
            10,
            50,
            22
          ],
          "varname": "ml_synced_clock"
        }
      },
      {
        "box": {
          "id": "phase",
          "text": "plugphasor~",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            450,
            10,
            66,
            22
          ],
          "varname": "ml_synced_phase"
        }
      },
      {
        "box": {
          "id": "gen",
          "text": "gen~ clock_anchored_envelope_probe.gendsp @nocache 1",
          "maxclass": "newobj",
          "numinlets": 4,
          "numoutlets": 15,
          "patching_rect": [
            150,
            60,
            312,
            22
          ],
          "varname": "ml_synced_gen"
        }
      },
      {
        "box": {
          "id": "fft",
          "text": "pfft~ tagged_spectrum_probe.maxpat 2048 1 0 1 @float32 0",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            150,
            110,
            336,
            22
          ],
          "varname": "ml_synced_fft"
        }
      },
      {
        "box": {
          "id": "collector",
          "text": "js hosted_calibration_probe.js",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            10,
            270,
            180,
            22
          ],
          "varname": "ml_synced_collector"
        }
      },
      {
        "box": {
          "id": "poll",
          "text": "qmetro 10 @active 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            110,
            114,
            22
          ],
          "varname": "ml_synced_poll"
        }
      },
      {
        "box": {
          "id": "clockSplit",
          "text": "gen~ clock_split_probe.gendsp @nocache 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            550,
            150,
            230,
            22
          ],
          "varname": "ml_synced_clockSplit"
        }
      },
      {
        "box": {
          "id": "pollOrder",
          "text": "trigger b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            150,
            66,
            22
          ],
          "varname": "ml_synced_pollOrder"
        }
      },
      {
        "box": {
          "id": "channels",
          "text": "mc.pack~ 13",
          "maxclass": "newobj",
          "numinlets": 13,
          "numoutlets": 1,
          "patching_rect": [
            150,
            150,
            66,
            22
          ],
          "varname": "ml_synced_channels"
        }
      },
      {
        "box": {
          "id": "snapshot",
          "text": "mc.snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            150,
            190,
            132,
            22
          ],
          "varname": "ml_synced_snapshot"
        }
      },
      {
        "box": {
          "id": "voice",
          "text": "route voice",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            400,
            150,
            66,
            22
          ],
          "varname": "ml_synced_voice"
        }
      },
      {
        "box": {
          "id": "gate",
          "text": "gate 13",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 13,
          "patching_rect": [
            400,
            190,
            50,
            22
          ],
          "varname": "ml_synced_gate"
        }
      },
      {
        "box": {
          "id": "pack",
          "text": "pack 0.125 0.125 0.125 0.125 0.125 0.125 0.125 0.125 0.125 0.125 0.125 0.125 0.125",
          "maxclass": "newobj",
          "numinlets": 13,
          "numoutlets": 1,
          "patching_rect": [
            150,
            230,
            492,
            22
          ],
          "varname": "ml_synced_pack"
        }
      },
      {
        "box": {
          "id": "print",
          "text": "print synchronized-native-report",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            10,
            320,
            192,
            22
          ],
          "varname": "ml_synced_print"
        }
      },
      {
        "box": {
          "id": "load",
          "text": "loadbang",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            600,
            10,
            50,
            22
          ],
          "varname": "ml_synced_load"
        }
      },
      {
        "box": {
          "id": "path",
          "text": "live.path live_set",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            600,
            50,
            108,
            22
          ],
          "varname": "ml_synced_path"
        }
      },
      {
        "box": {
          "id": "song",
          "text": "live.object",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            600,
            110,
            66,
            22
          ],
          "varname": "ml_synced_song"
        }
      },
      {
        "box": {
          "id": "sourceId",
          "text": "print synchronized-native-source",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            500,
            320,
            192,
            22
          ],
          "varname": "ml_synced_sourceId"
        }
      },
      {
        "box": {
          "id": "route",
          "text": "route origin fft-diagnostics",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            10,
            60,
            168,
            22
          ],
          "varname": "ml_synced_route"
        }
      },
      {
        "box": {
          "id": "diagCommand",
          "text": "diagnostics",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            10,
            90,
            66,
            22
          ],
          "varname": "ml_synced_diagCommand"
        }
      },
      {
        "box": {
          "id": "originPoll",
          "text": "trigger b b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            400,
            60,
            78,
            22
          ],
          "varname": "ml_synced_originPoll"
        }
      },
      {
        "box": {
          "id": "originPack",
          "text": "pack origin 0 0.125 0.125",
          "maxclass": "newobj",
          "numinlets": 4,
          "numoutlets": 1,
          "patching_rect": [
            400,
            270,
            150,
            22
          ],
          "varname": "ml_synced_originPack"
        }
      },
      {
        "box": {
          "id": "originHot",
          "text": "trigger b f",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            650,
            230,
            66,
            22
          ],
          "varname": "ml_synced_originHot"
        }
      },
      {
        "box": {
          "id": "originPrint",
          "text": "print synchronized-native-origin",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            300,
            320,
            192,
            22
          ],
          "varname": "ml_synced_originPrint"
        }
      },
      {
        "box": {
          "id": "clockOut",
          "text": "out~ 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            150,
            350,
            50,
            22
          ],
          "varname": "ml_synced_clockOut"
        }
      },
      {
        "box": {
          "id": "originSnap2",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            600,
            230,
            114,
            22
          ],
          "varname": "ml_synced_originSnap2"
        }
      },
      {
        "box": {
          "id": "originSnap1",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            500,
            230,
            114,
            22
          ],
          "varname": "ml_synced_originSnap1"
        }
      },
      {
        "box": {
          "id": "originSnap0",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            400,
            230,
            114,
            22
          ],
          "varname": "ml_synced_originSnap0"
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "command",
            0
          ],
          "destination": [
            "route",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "route",
            2
          ],
          "destination": [
            "collector",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "route",
            0
          ],
          "destination": [
            "originPoll",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "route",
            1
          ],
          "destination": [
            "diagCommand",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagCommand",
            0
          ],
          "destination": [
            "fft",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "left",
            0
          ],
          "destination": [
            "gen",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "right",
            0
          ],
          "destination": [
            "gen",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "phase",
            0
          ],
          "destination": [
            "gen",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            0
          ],
          "destination": [
            "gen",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            0
          ],
          "destination": [
            "clockOut",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "left",
            0
          ],
          "destination": [
            "fft",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "right",
            0
          ],
          "destination": [
            "fft",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            0
          ],
          "destination": [
            "clockSplit",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clockSplit",
            0
          ],
          "destination": [
            "fft",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clockSplit",
            1
          ],
          "destination": [
            "fft",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "fft",
            0
          ],
          "destination": [
            "collector",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "collector",
            0
          ],
          "destination": [
            "print",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "collector",
            1
          ],
          "destination": [
            "gen",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "collector",
            2
          ],
          "destination": [
            "song",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "load",
            0
          ],
          "destination": [
            "path",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "path",
            0
          ],
          "destination": [
            "song",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "path",
            0
          ],
          "destination": [
            "sourceId",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "poll",
            0
          ],
          "destination": [
            "pollOrder",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "pollOrder",
            1
          ],
          "destination": [
            "fft",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "pollOrder",
            0
          ],
          "destination": [
            "snapshot",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "channels",
            0
          ],
          "destination": [
            "snapshot",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapshot",
            1
          ],
          "destination": [
            "voice",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "voice",
            0
          ],
          "destination": [
            "gate",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapshot",
            0
          ],
          "destination": [
            "gate",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "pack",
            0
          ],
          "destination": [
            "collector",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originHot",
            1
          ],
          "destination": [
            "originPack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originHot",
            0
          ],
          "destination": [
            "originPack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originPack",
            0
          ],
          "destination": [
            "originPrint",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            0
          ],
          "destination": [
            "channels",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            0
          ],
          "destination": [
            "pack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            1
          ],
          "destination": [
            "channels",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            1
          ],
          "destination": [
            "pack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            2
          ],
          "destination": [
            "channels",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            2
          ],
          "destination": [
            "pack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            3
          ],
          "destination": [
            "channels",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            3
          ],
          "destination": [
            "pack",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            4
          ],
          "destination": [
            "channels",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            4
          ],
          "destination": [
            "pack",
            5
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            5
          ],
          "destination": [
            "channels",
            5
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            5
          ],
          "destination": [
            "pack",
            6
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            6
          ],
          "destination": [
            "channels",
            6
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            6
          ],
          "destination": [
            "pack",
            7
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            7
          ],
          "destination": [
            "channels",
            7
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            7
          ],
          "destination": [
            "pack",
            8
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            8
          ],
          "destination": [
            "channels",
            8
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            8
          ],
          "destination": [
            "pack",
            9
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            9
          ],
          "destination": [
            "channels",
            9
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            9
          ],
          "destination": [
            "pack",
            10
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            10
          ],
          "destination": [
            "channels",
            10
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            10
          ],
          "destination": [
            "pack",
            11
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            11
          ],
          "destination": [
            "channels",
            11
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            11
          ],
          "destination": [
            "pack",
            12
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            12
          ],
          "destination": [
            "channels",
            12
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gate",
            12
          ],
          "destination": [
            "pack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            0
          ],
          "destination": [
            "originSnap2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originPoll",
            2
          ],
          "destination": [
            "originSnap2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originSnap2",
            0
          ],
          "destination": [
            "originPack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            13
          ],
          "destination": [
            "originSnap1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originPoll",
            1
          ],
          "destination": [
            "originSnap1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originSnap1",
            0
          ],
          "destination": [
            "originPack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gen",
            14
          ],
          "destination": [
            "originSnap0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originPoll",
            0
          ],
          "destination": [
            "originSnap0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "originSnap0",
            0
          ],
          "destination": [
            "originHot",
            0
          ]
        }
      }
    ]
  }
}
