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
          "varname": "ml_anchor_command"
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
            310,
            180,
            22
          ],
          "varname": "ml_anchor_collector"
        }
      },
      {
        "box": {
          "id": "clock",
          "text": "gen~ calibration_clock.gendsp @nocache 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 7,
          "patching_rect": [
            200,
            10,
            240,
            22
          ],
          "varname": "ml_anchor_clock"
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
            480,
            10,
            66,
            22
          ],
          "varname": "ml_anchor_phase"
        }
      },
      {
        "box": {
          "id": "channels",
          "text": "mc.pack~ 3",
          "maxclass": "newobj",
          "numinlets": 3,
          "numoutlets": 1,
          "patching_rect": [
            200,
            50,
            60,
            22
          ],
          "varname": "ml_anchor_channels"
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
            200,
            90,
            132,
            22
          ],
          "varname": "ml_anchor_snapshot"
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
            450,
            90,
            66,
            22
          ],
          "varname": "ml_anchor_voice"
        }
      },
      {
        "box": {
          "id": "gate",
          "text": "gate 3",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 3,
          "patching_rect": [
            450,
            125,
            50,
            22
          ],
          "varname": "ml_anchor_gate"
        }
      },
      {
        "box": {
          "id": "clockPack",
          "text": "pack anchor_clock 0.125 0.125 0.125",
          "maxclass": "newobj",
          "numinlets": 4,
          "numoutlets": 1,
          "patching_rect": [
            200,
            170,
            210,
            22
          ],
          "varname": "ml_anchor_clockPack"
        }
      },
      {
        "box": {
          "id": "clockHot",
          "text": "trigger b f",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            600,
            125,
            66,
            22
          ],
          "varname": "ml_anchor_clockHot"
        }
      },
      {
        "box": {
          "id": "host",
          "text": "plugsync~",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 9,
          "patching_rect": [
            10,
            90,
            54,
            22
          ],
          "varname": "ml_anchor_host"
        }
      },
      {
        "box": {
          "id": "prePack",
          "text": "pack anchor_pre 0 0.125 0.125 0",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            10,
            210,
            186,
            22
          ],
          "varname": "ml_anchor_prePack"
        }
      },
      {
        "box": {
          "id": "postPack",
          "text": "pack anchor_post 0 0.125 0.125 0",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            400,
            210,
            192,
            22
          ],
          "varname": "ml_anchor_postPack"
        }
      },
      {
        "box": {
          "id": "poll",
          "text": "qmetro 10 @active 0",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            50,
            114,
            22
          ],
          "varname": "ml_anchor_poll"
        }
      },
      {
        "box": {
          "id": "order",
          "text": "trigger b b b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 4,
          "patching_rect": [
            10,
            125,
            90,
            22
          ],
          "varname": "ml_anchor_order"
        }
      },
      {
        "box": {
          "id": "preOrder",
          "text": "trigger b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            170,
            66,
            22
          ],
          "varname": "ml_anchor_preOrder"
        }
      },
      {
        "box": {
          "id": "postOrder",
          "text": "trigger b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            120,
            170,
            66,
            22
          ],
          "varname": "ml_anchor_postOrder"
        }
      },
      {
        "box": {
          "id": "dspOrder",
          "text": "trigger b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            600,
            50,
            66,
            22
          ],
          "varname": "ml_anchor_dspOrder"
        }
      },
      {
        "box": {
          "id": "dsp",
          "text": "dspstate~",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 4,
          "patching_rect": [
            600,
            90,
            54,
            22
          ],
          "varname": "ml_anchor_dsp"
        }
      },
      {
        "box": {
          "id": "dspPack",
          "text": "pack anchor_dsp 0 0.125 0",
          "maxclass": "newobj",
          "numinlets": 4,
          "numoutlets": 1,
          "patching_rect": [
            400,
            250,
            150,
            22
          ],
          "varname": "ml_anchor_dspPack"
        }
      },
      {
        "box": {
          "id": "output",
          "text": "print host-clock-native-report",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            10,
            350,
            180,
            22
          ],
          "varname": "ml_anchor_output"
        }
      },
      {
        "box": {
          "id": "clockOutput",
          "text": "out~ 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            240,
            350,
            50,
            22
          ],
          "varname": "ml_anchor_clockOutput"
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
            "output",
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
            "poll",
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
            "order",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "order",
            3
          ],
          "destination": [
            "dspOrder",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dspOrder",
            1
          ],
          "destination": [
            "dsp",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dspOrder",
            0
          ],
          "destination": [
            "dspPack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dsp",
            0
          ],
          "destination": [
            "dspPack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dsp",
            1
          ],
          "destination": [
            "dspPack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dsp",
            2
          ],
          "destination": [
            "dspPack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dspPack",
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
            "order",
            2
          ],
          "destination": [
            "preOrder",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "preOrder",
            1
          ],
          "destination": [
            "host",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "preOrder",
            0
          ],
          "destination": [
            "prePack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "prePack",
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
            "order",
            1
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
            "order",
            0
          ],
          "destination": [
            "postOrder",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "postOrder",
            1
          ],
          "destination": [
            "host",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "postOrder",
            0
          ],
          "destination": [
            "postPack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "postPack",
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
            "clock",
            1
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
            "phase",
            0
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
            "clock",
            1
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
            "clock",
            1
          ],
          "destination": [
            "clockOutput",
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
            "gate",
            0
          ],
          "destination": [
            "clockPack",
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
            "clockPack",
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
            "clockHot",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clockHot",
            1
          ],
          "destination": [
            "clockPack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clockHot",
            0
          ],
          "destination": [
            "clockPack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clockPack",
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
            "host",
            0
          ],
          "destination": [
            "prePack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            6
          ],
          "destination": [
            "prePack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            7
          ],
          "destination": [
            "prePack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            8
          ],
          "destination": [
            "prePack",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            0
          ],
          "destination": [
            "postPack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            6
          ],
          "destination": [
            "postPack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            7
          ],
          "destination": [
            "postPack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "host",
            8
          ],
          "destination": [
            "postPack",
            4
          ]
        }
      }
    ]
  }
}
