{
  "patcher": {
    "fileversion": 1,
    "appversion": {
      "major": 8,
      "minor": 5,
      "revision": 5,
      "architecture": "x64",
      "modernui": 1
    },
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
          "id": "input",
          "maxclass": "newobj",
          "text": "plugin~",
          "numinlets": 2,
          "numoutlets": 2,
          "patching_rect": [
            10,
            30,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "output",
          "maxclass": "newobj",
          "text": "plugout~",
          "numinlets": 2,
          "numoutlets": 2,
          "patching_rect": [
            10,
            310,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "analysis",
          "maxclass": "newobj",
          "text": "poly~ audio_listener_analysis 1 @parallel 0",
          "numinlets": 3,
          "numoutlets": 7,
          "patching_rect": [
            170,
            55,
            258,
            22
          ]
        }
      },
      {
        "box": {
          "id": "idle",
          "maxclass": "newobj",
          "text": "loadmess mute 0 1",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            90,
            102,
            22
          ]
        }
      },
      {
        "box": {
          "id": "guard",
          "maxclass": "newobj",
          "text": "js audio_listener_guard.js",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            460,
            95,
            156,
            22
          ]
        }
      },
      {
        "box": {
          "id": "node",
          "maxclass": "newobj",
          "text": "node.script audio_listener_max.js @autostart 1 @watch 0",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            340,
            310,
            330,
            22
          ]
        }
      },
      {
        "box": {
          "id": "nodeMessages",
          "maxclass": "newobj",
          "text": "route adapter-started",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            460,
            340,
            126,
            22
          ]
        }
      },
      {
        "box": {
          "id": "identity",
          "maxclass": "newobj",
          "text": "js producer_identity_common.js watch",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            570,
            30,
            210,
            22
          ]
        }
      },
      {
        "box": {
          "id": "init",
          "maxclass": "newobj",
          "text": "live.thisdevice",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            460,
            30,
            90,
            22
          ]
        }
      },
      {
        "box": {
          "id": "enabled",
          "maxclass": "newobj",
          "text": "prepend device-enabled",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            120,
            132,
            22
          ]
        }
      },
      {
        "box": {
          "id": "clock",
          "maxclass": "newobj",
          "text": "qmetro 10 @active 1",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            160,
            114,
            22
          ]
        }
      },
      {
        "box": {
          "id": "tick",
          "maxclass": "newobj",
          "text": "trigger b b b",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            10,
            200,
            78,
            22
          ]
        }
      },
      {
        "box": {
          "id": "hostTrigger",
          "maxclass": "newobj",
          "text": "trigger b b",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            170,
            200,
            66,
            22
          ]
        }
      },
      {
        "box": {
          "id": "host",
          "maxclass": "newobj",
          "text": "plugsync~",
          "numinlets": 1,
          "numoutlets": 9,
          "patching_rect": [
            170,
            160,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "hostPack",
          "maxclass": "newobj",
          "text": "pack host 0 0. 0. 0",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            170,
            245,
            114,
            22
          ]
        }
      },
      {
        "box": {
          "id": "dspTrigger",
          "maxclass": "newobj",
          "text": "trigger b b",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            670,
            160,
            66,
            22
          ]
        }
      },
      {
        "box": {
          "id": "dsp",
          "maxclass": "newobj",
          "text": "dspstate~",
          "numinlets": 1,
          "numoutlets": 4,
          "patching_rect": [
            560,
            160,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "dspPack",
          "maxclass": "newobj",
          "text": "pack dsp 0 0. 0",
          "numinlets": 4,
          "numoutlets": 1,
          "patching_rect": [
            600,
            200,
            90,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snapTrigger",
          "maxclass": "newobj",
          "text": "trigger b b b b b b b",
          "numinlets": 1,
          "numoutlets": 7,
          "patching_rect": [
            10,
            245,
            126,
            22
          ]
        }
      },
      {
        "box": {
          "id": "spectralPoll",
          "maxclass": "newobj",
          "text": "trigger b b",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            280,
            66,
            22
          ]
        }
      },
      {
        "box": {
          "id": "spectralSnapshot",
          "maxclass": "message",
          "text": "snapshot",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            170,
            280,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "framePack",
          "maxclass": "newobj",
          "text": "pack 0. 0. 0. 0. 0. 0. 0.",
          "numinlets": 7,
          "numoutlets": 1,
          "patching_rect": [
            340,
            245,
            150,
            22
          ]
        }
      },
      {
        "box": {
          "id": "frameMsg",
          "maxclass": "newobj",
          "text": "prepend frame",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            340,
            280,
            78,
            22
          ]
        }
      },
      {
        "box": {
          "id": "threshold",
          "maxclass": "live.dial",
          "text": "",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            55,
            60,
            40
          ],
          "varname": "threshold",
          "parameter_enable": 1,
          "presentation": 1,
          "presentation_rect": [
            10,
            55,
            70,
            50
          ],
          "saved_attribute_attributes": {
            "valueof": {
              "parameter_longname": "Attack rise dB",
              "parameter_shortname": "Attack rise dB",
              "parameter_type": 0,
              "parameter_mmin": 0,
              "parameter_mmax": 120,
              "parameter_initial_enable": 1,
              "parameter_initial": [
                6
              ]
            }
          }
        }
      },
      {
        "box": {
          "id": "thresholdMsg",
          "maxclass": "newobj",
          "text": "prepend attack-threshold",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            15,
            144,
            22
          ]
        }
      },
      {
        "box": {
          "id": "spacing",
          "maxclass": "live.dial",
          "text": "",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            85,
            55,
            60,
            40
          ],
          "varname": "spacing",
          "parameter_enable": 1,
          "presentation": 1,
          "presentation_rect": [
            85,
            55,
            70,
            50
          ],
          "saved_attribute_attributes": {
            "valueof": {
              "parameter_longname": "Attack gap ms",
              "parameter_shortname": "Attack gap ms",
              "parameter_type": 0,
              "parameter_mmin": 100,
              "parameter_mmax": 2000,
              "parameter_initial_enable": 1,
              "parameter_initial": [
                100
              ]
            }
          }
        }
      },
      {
        "box": {
          "id": "spacingMsg",
          "maxclass": "newobj",
          "text": "prepend attack-spacing-ms",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            85,
            15,
            150,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap0",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            170,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap1",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            255,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap2",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            340,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap3",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            425,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap4",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            510,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap5",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            595,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snap6",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            680,
            120,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "label",
          "maxclass": "comment",
          "text": "Audio Listener — transparent stereo tap; production capture requires real-Live calibration",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            10,
            350,
            540,
            22
          ],
          "presentation": 1,
          "presentation_rect": [
            8,
            8,
            540,
            40
          ]
        }
      },
      {
        "box": {
          "id": "ml_device_preview",
          "maxclass": "newobj",
          "text": "prepend device-preview",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            670,
            240,
            110,
            22
          ],
          "varname": "ml_device_preview"
        }
      },
      {
        "box": {
          "id": "ml_adapter_init",
          "maxclass": "newobj",
          "text": "trigger b b b",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            670,
            275,
            78,
            22
          ],
          "varname": "ml_adapter_init"
        }
      },
      {
        "box": {
          "id": "ml_device_state_query",
          "maxclass": "message",
          "text": "getstate",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            670,
            310,
            60,
            22
          ],
          "varname": "ml_device_state_query"
        }
      },
      {
        "box": {
          "id": "ml_device_preview_latch",
          "maxclass": "newobj",
          "text": "int -1",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            670,
            345,
            60,
            22
          ],
          "varname": "ml_device_preview_latch"
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "input",
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
            "input",
            1
          ],
          "destination": [
            "output",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "input",
            0
          ],
          "destination": [
            "analysis",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "input",
            1
          ],
          "destination": [
            "analysis",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "idle",
            0
          ],
          "destination": [
            "analysis",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "node",
            0
          ],
          "destination": [
            "nodeMessages",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "nodeMessages",
            1
          ],
          "destination": [
            "guard",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "guard",
            0
          ],
          "destination": [
            "analysis",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "guard",
            1
          ],
          "destination": [
            "analysis",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "guard",
            2
          ],
          "destination": [
            "clock",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "init",
            0
          ],
          "destination": [
            "identity",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "identity",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "init",
            1
          ],
          "destination": [
            "enabled",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "enabled",
            0
          ],
          "destination": [
            "node",
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
            "tick",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "tick",
            2
          ],
          "destination": [
            "dspTrigger",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "tick",
            1
          ],
          "destination": [
            "hostTrigger",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "tick",
            0
          ],
          "destination": [
            "spectralPoll",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spectralPoll",
            1
          ],
          "destination": [
            "spectralSnapshot",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spectralSnapshot",
            0
          ],
          "destination": [
            "analysis",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spectralPoll",
            0
          ],
          "destination": [
            "snapTrigger",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "hostTrigger",
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
            "hostTrigger",
            0
          ],
          "destination": [
            "hostPack",
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
            "hostPack",
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
            "hostPack",
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
            "hostPack",
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
            "hostPack",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "hostPack",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "dspTrigger",
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
            "dspTrigger",
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
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "framePack",
            0
          ],
          "destination": [
            "frameMsg",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "frameMsg",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "threshold",
            0
          ],
          "destination": [
            "thresholdMsg",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "thresholdMsg",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "init",
            0
          ],
          "destination": [
            "threshold",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spacing",
            0
          ],
          "destination": [
            "spacingMsg",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spacingMsg",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "init",
            0
          ],
          "destination": [
            "spacing",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            0
          ],
          "destination": [
            "snap0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            0
          ],
          "destination": [
            "snap0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap0",
            0
          ],
          "destination": [
            "framePack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            1
          ],
          "destination": [
            "snap1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            1
          ],
          "destination": [
            "snap1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap1",
            0
          ],
          "destination": [
            "framePack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            2
          ],
          "destination": [
            "snap2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            2
          ],
          "destination": [
            "snap2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap2",
            0
          ],
          "destination": [
            "framePack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            3
          ],
          "destination": [
            "snap3",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            3
          ],
          "destination": [
            "snap3",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap3",
            0
          ],
          "destination": [
            "framePack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            4
          ],
          "destination": [
            "snap4",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            4
          ],
          "destination": [
            "snap4",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap4",
            0
          ],
          "destination": [
            "framePack",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            5
          ],
          "destination": [
            "snap5",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            5
          ],
          "destination": [
            "snap5",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap5",
            0
          ],
          "destination": [
            "framePack",
            5
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "analysis",
            6
          ],
          "destination": [
            "snap6",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snapTrigger",
            6
          ],
          "destination": [
            "snap6",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "snap6",
            0
          ],
          "destination": [
            "framePack",
            6
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "init",
            2
          ],
          "destination": [
            "ml_device_preview",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "ml_device_preview",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "nodeMessages",
            0
          ],
          "destination": [
            "ml_adapter_init",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "ml_adapter_init",
            2
          ],
          "destination": [
            "ml_device_state_query",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "ml_device_state_query",
            0
          ],
          "destination": [
            "init",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "ml_adapter_init",
            0
          ],
          "destination": [
            "init",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "init",
            2
          ],
          "destination": [
            "ml_device_preview_latch",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "ml_adapter_init",
            1
          ],
          "destination": [
            "ml_device_preview_latch",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "ml_device_preview_latch",
            0
          ],
          "destination": [
            "ml_device_preview",
            0
          ]
        }
      }
    ],
    "devicewidth": 560,
    "openinpresentation": 1,
    "parameters": {
      "threshold": [
        "Attack rise dB",
        "Attack rise dB",
        0
      ],
      "spacing": [
        "Attack gap ms",
        "Attack gap ms",
        0
      ]
    },
    "description": "On-demand native measurements. No audio recording. Calibration required.",
    "dependency_cache": []
  }
}
