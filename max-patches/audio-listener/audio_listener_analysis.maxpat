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
          "id": "left",
          "maxclass": "newobj",
          "text": "in~ 1",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            15,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "right",
          "maxclass": "newobj",
          "text": "in~ 2",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            180,
            15,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "command",
          "maxclass": "newobj",
          "text": "in 3",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            440,
            15,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "route",
          "maxclass": "newobj",
          "text": "route reset sourceSampleRate snapshot reload",
          "numinlets": 1,
          "numoutlets": 5,
          "patching_rect": [
            440,
            60,
            264,
            22
          ]
        }
      },
      {
        "box": {
          "id": "reset",
          "maxclass": "message",
          "text": "reset",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            440,
            100,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "fftclear",
          "maxclass": "message",
          "text": "clear",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            560,
            100,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "sr",
          "maxclass": "newobj",
          "text": "prepend sourceSampleRate",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            570,
            60,
            144,
            22
          ]
        }
      },
      {
        "box": {
          "id": "envelope",
          "maxclass": "newobj",
          "text": "gen~ audio_listener_envelope @nocache 1",
          "numinlets": 2,
          "numoutlets": 5,
          "patching_rect": [
            10,
            135,
            234,
            22
          ]
        }
      },
      {
        "box": {
          "id": "spectrum",
          "maxclass": "newobj",
          "text": "pfft~ audio_listener_spectrum 2048 1 0 1",
          "numinlets": 3,
          "numoutlets": 2,
          "patching_rect": [
            350,
            155,
            240,
            22
          ]
        }
      },
      {
        "box": {
          "id": "snapshot",
          "maxclass": "message",
          "text": "snapshot",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            440,
            130,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "reload",
          "maxclass": "message",
          "text": "reload",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            590,
            130,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "centroidHold",
          "maxclass": "newobj",
          "text": "sig~ 0.",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            350,
            205,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "energyHold",
          "maxclass": "newobj",
          "text": "sig~ 0.",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            500,
            205,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "clearHold",
          "maxclass": "message",
          "text": "0",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            650,
            205,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "genreset",
          "maxclass": "message",
          "text": "reset",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            675,
            100,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out0",
          "maxclass": "newobj",
          "text": "out~ 1",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            10,
            260,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out1",
          "maxclass": "newobj",
          "text": "out~ 2",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            115,
            260,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out2",
          "maxclass": "newobj",
          "text": "out~ 3",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            220,
            260,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out3",
          "maxclass": "newobj",
          "text": "out~ 4",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            325,
            260,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out4",
          "maxclass": "newobj",
          "text": "out~ 5",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            430,
            260,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out5",
          "maxclass": "newobj",
          "text": "out~ 6",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            535,
            260,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "out6",
          "maxclass": "newobj",
          "text": "out~ 7",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            640,
            260,
            60,
            22
          ]
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "left",
            0
          ],
          "destination": [
            "envelope",
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
            "envelope",
            1
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
            "spectrum",
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
            "spectrum",
            1
          ]
        }
      },
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
            0
          ],
          "destination": [
            "reset",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "reset",
            0
          ],
          "destination": [
            "envelope",
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
            "fftclear",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "fftclear",
            0
          ],
          "destination": [
            "spectrum",
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
            "sr",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "sr",
            0
          ],
          "destination": [
            "spectrum",
            2
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
            "snapshot",
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
            "spectrum",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "route",
            3
          ],
          "destination": [
            "reload",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "reload",
            0
          ],
          "destination": [
            "spectrum",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spectrum",
            0
          ],
          "destination": [
            "centroidHold",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "spectrum",
            1
          ],
          "destination": [
            "energyHold",
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
            "clearHold",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clearHold",
            0
          ],
          "destination": [
            "centroidHold",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clearHold",
            0
          ],
          "destination": [
            "energyHold",
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
            "genreset",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "genreset",
            0
          ],
          "destination": [
            "spectrum",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "envelope",
            0
          ],
          "destination": [
            "out0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "envelope",
            1
          ],
          "destination": [
            "out1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "envelope",
            2
          ],
          "destination": [
            "out2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "envelope",
            3
          ],
          "destination": [
            "out3",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "envelope",
            4
          ],
          "destination": [
            "out4",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "centroidHold",
            0
          ],
          "destination": [
            "out5",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energyHold",
            0
          ],
          "destination": [
            "out6",
            0
          ]
        }
      }
    ]
  }
}
