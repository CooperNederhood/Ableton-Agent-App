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
          "text": "fftin~ 1 square",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            10,
            20,
            90,
            22
          ]
        }
      },
      {
        "box": {
          "id": "right",
          "maxclass": "newobj",
          "text": "fftin~ 2 square",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            250,
            20,
            90,
            22
          ]
        }
      },
      {
        "box": {
          "id": "config",
          "maxclass": "newobj",
          "text": "in 3",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            530,
            20,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "energy",
          "maxclass": "newobj",
          "text": "gen~ audio_listener_spectrum_energy @nocache 1",
          "numinlets": 5,
          "numoutlets": 2,
          "patching_rect": [
            10,
            110,
            276,
            22
          ]
        }
      },
      {
        "box": {
          "id": "route",
          "maxclass": "newobj",
          "text": "route snapshot reload",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            530,
            60,
            126,
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
            660,
            100,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "poll",
          "maxclass": "newobj",
          "text": "trigger b b",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            530,
            100,
            66,
            22
          ]
        }
      },
      {
        "box": {
          "id": "centroidSnap",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            10,
            175,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "energySnap",
          "maxclass": "newobj",
          "text": "snapshot~",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            240,
            175,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "centroid",
          "maxclass": "newobj",
          "text": "out 1",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            10,
            230,
            60,
            22
          ]
        }
      },
      {
        "box": {
          "id": "total",
          "maxclass": "newobj",
          "text": "out 2",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            240,
            230,
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
            "energy",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "left",
            1
          ],
          "destination": [
            "energy",
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
            "energy",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "right",
            1
          ],
          "destination": [
            "energy",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "left",
            2
          ],
          "destination": [
            "energy",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "config",
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
            "energy",
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
            "poll",
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
            "energy",
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
            "centroidSnap",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "poll",
            1
          ],
          "destination": [
            "energySnap",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            0
          ],
          "destination": [
            "centroidSnap",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            1
          ],
          "destination": [
            "energySnap",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "centroidSnap",
            0
          ],
          "destination": [
            "centroid",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energySnap",
            0
          ],
          "destination": [
            "total",
            0
          ]
        }
      }
    ]
  }
}
