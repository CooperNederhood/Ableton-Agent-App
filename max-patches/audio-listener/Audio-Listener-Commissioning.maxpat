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
          "id": "buffer",
          "text": "buffer~ #0-commission-fixture 0 2",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            20,
            198,
            22
          ]
        }
      },
      {
        "box": {
          "id": "info",
          "text": "info~ #0-commission-fixture",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 10,
          "patching_rect": [
            10,
            65,
            162,
            22
          ]
        }
      },
      {
        "box": {
          "id": "loadedTrigger",
          "text": "trigger b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            110,
            66,
            22
          ]
        }
      },
      {
        "box": {
          "id": "loaded",
          "text": "pack loaded 0. 0. 0 s",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            10,
            150,
            126,
            22
          ]
        }
      },
      {
        "box": {
          "id": "clock",
          "text": "gen~ calibration_clock",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 7,
          "patching_rect": [
            270,
            20,
            132,
            22
          ]
        }
      },
      {
        "box": {
          "id": "left",
          "text": "index~ #0-commission-fixture 1",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            270,
            65,
            180,
            22
          ]
        }
      },
      {
        "box": {
          "id": "right",
          "text": "index~ #0-commission-fixture 2",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            450,
            65,
            180,
            22
          ]
        }
      },
      {
        "box": {
          "id": "gateL",
          "text": "*~ 0.",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            270,
            110,
            50,
            22
          ]
        }
      },
      {
        "box": {
          "id": "gateR",
          "text": "*~ 0.",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            450,
            110,
            50,
            22
          ]
        }
      },
      {
        "box": {
          "id": "analysis",
          "text": "poly~ audio_listener_analysis 1 @parallel 0",
          "maxclass": "newobj",
          "numinlets": 3,
          "numoutlets": 7,
          "patching_rect": [
            270,
            155,
            258,
            22
          ]
        }
      },
      {
        "box": {
          "id": "packet",
          "text": "p native-packet",
          "maxclass": "newobj",
          "numinlets": 14,
          "numoutlets": 1,
          "patching_rect": [
            10,
            205,
            90,
            22
          ],
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
                  "id": "bang",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    0,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "tick",
                  "text": "trigger b b b b b b b b b b b b b",
                  "maxclass": "newobj",
                  "numinlets": 1,
                  "numoutlets": 13,
                  "patching_rect": [
                    10,
                    110,
                    198,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "pack",
                  "text": "pack 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.",
                  "maxclass": "newobj",
                  "numinlets": 13,
                  "numoutlets": 1,
                  "patching_rect": [
                    10,
                    165,
                    258,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "msg",
                  "text": "prepend frame",
                  "maxclass": "newobj",
                  "numinlets": 1,
                  "numoutlets": 1,
                  "patching_rect": [
                    10,
                    220,
                    78,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "out",
                  "text": "",
                  "maxclass": "outlet",
                  "numinlets": 1,
                  "numoutlets": 0,
                  "patching_rect": [
                    10,
                    280,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in0",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    55,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap0",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    55,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in1",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    110,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap1",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    110,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in2",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    165,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap2",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    165,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in3",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    220,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap3",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    220,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in4",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    275,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap4",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    275,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in5",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    330,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap5",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    330,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in6",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    385,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap6",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    385,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in7",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    440,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap7",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    440,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in8",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    495,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap8",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    495,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in9",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    550,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap9",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    550,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in10",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    605,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap10",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    605,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in11",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    660,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap11",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    660,
                    65,
                    114,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "in12",
                  "text": "",
                  "maxclass": "inlet",
                  "numinlets": 0,
                  "numoutlets": 1,
                  "patching_rect": [
                    715,
                    10,
                    50,
                    22
                  ]
                }
              },
              {
                "box": {
                  "id": "snap12",
                  "text": "snapshot~ @offset 0",
                  "maxclass": "newobj",
                  "numinlets": 2,
                  "numoutlets": 1,
                  "patching_rect": [
                    715,
                    65,
                    65,
                    22
                  ]
                }
              }
            ],
            "lines": [
              {
                "patchline": {
                  "source": [
                    "bang",
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
                    "pack",
                    0
                  ],
                  "destination": [
                    "msg",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "msg",
                    0
                  ],
                  "destination": [
                    "out",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in0",
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
                    "tick",
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
                    "pack",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in1",
                    0
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
                    "tick",
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
                    "pack",
                    1
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in2",
                    0
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
                    "tick",
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
                    "pack",
                    2
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in3",
                    0
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
                    "tick",
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
                    "pack",
                    3
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in4",
                    0
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
                    "tick",
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
                    "pack",
                    4
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in5",
                    0
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
                    "tick",
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
                    "pack",
                    5
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in6",
                    0
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
                    "tick",
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
                    "pack",
                    6
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "in7",
                    0
                  ],
                  "destination": [
                    "snap7",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "tick",
                    7
                  ],
                  "destination": [
                    "snap7",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "snap7",
                    0
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
                    "in8",
                    0
                  ],
                  "destination": [
                    "snap8",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "tick",
                    8
                  ],
                  "destination": [
                    "snap8",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "snap8",
                    0
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
                    "in9",
                    0
                  ],
                  "destination": [
                    "snap9",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "tick",
                    9
                  ],
                  "destination": [
                    "snap9",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "snap9",
                    0
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
                    "in10",
                    0
                  ],
                  "destination": [
                    "snap10",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "tick",
                    10
                  ],
                  "destination": [
                    "snap10",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "snap10",
                    0
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
                    "in11",
                    0
                  ],
                  "destination": [
                    "snap11",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "tick",
                    11
                  ],
                  "destination": [
                    "snap11",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "snap11",
                    0
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
                    "in12",
                    0
                  ],
                  "destination": [
                    "snap12",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "tick",
                    12
                  ],
                  "destination": [
                    "snap12",
                    0
                  ]
                }
              },
              {
                "patchline": {
                  "source": [
                    "snap12",
                    0
                  ],
                  "destination": [
                    "pack",
                    12
                  ]
                }
              }
            ]
          }
        }
      },
      {
        "box": {
          "id": "qmetro",
          "text": "qmetro 10 @active 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            250,
            114,
            22
          ]
        }
      },
      {
        "box": {
          "id": "poll",
          "text": "trigger b b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            10,
            290,
            78,
            22
          ]
        }
      },
      {
        "box": {
          "id": "spectralSnapshot",
          "text": "snapshot",
          "maxclass": "message",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            160,
            290,
            50,
            22
          ]
        }
      },
      {
        "box": {
          "id": "dspTrigger",
          "text": "trigger b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            630,
            20,
            66,
            22
          ]
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
            630,
            65,
            54,
            22
          ]
        }
      },
      {
        "box": {
          "id": "dspPack",
          "text": "pack dsp 0 0. 0 0",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            630,
            110,
            102,
            22
          ]
        }
      },
      {
        "box": {
          "id": "guard",
          "text": "js calibration_guard.js",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 5,
          "patching_rect": [
            470,
            250,
            138,
            22
          ]
        }
      },
      {
        "box": {
          "id": "node",
          "text": "node.script calibration_controller.js @autostart 1 @watch 0",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            440,
            310,
            340,
            22
          ]
        }
      },
      {
        "box": {
          "id": "idle",
          "text": "loadmess stop 1 startup",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            270,
            250,
            138,
            22
          ]
        }
      },
      {
        "box": {
          "id": "authorize",
          "text": "authorize runner-owned",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            10,
            345,
            132,
            22
          ]
        }
      },
      {
        "box": {
          "id": "fixture",
          "text": "fixture silence",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            175,
            345,
            90,
            22
          ]
        }
      },
      {
        "box": {
          "id": "start",
          "text": "start",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            300,
            345,
            50,
            22
          ]
        }
      },
      {
        "box": {
          "id": "cancel",
          "text": "cancel",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            365,
            345,
            50,
            22
          ]
        }
      },
      {
        "box": {
          "id": "report",
          "text": "report",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            630,
            345,
            50,
            22
          ]
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": [
            "buffer",
            1
          ],
          "destination": [
            "loadedTrigger",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "loadedTrigger",
            1
          ],
          "destination": [
            "info",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "loadedTrigger",
            0
          ],
          "destination": [
            "loaded",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            0
          ],
          "destination": [
            "loaded",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            6
          ],
          "destination": [
            "loaded",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            8
          ],
          "destination": [
            "loaded",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            7
          ],
          "destination": [
            "loaded",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "loaded",
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
            "left",
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
            "right",
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
            "gateL",
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
            "gateR",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            6
          ],
          "destination": [
            "gateL",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            6
          ],
          "destination": [
            "gateR",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "gateL",
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
            "gateR",
            0
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
            "qmetro",
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
            "poll",
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
            "poll",
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
            "poll",
            0
          ],
          "destination": [
            "packet",
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
            "dsp",
            3
          ],
          "destination": [
            "dspPack",
            4
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
            "packet",
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
            "node",
            0
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
            "idle",
            0
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
            "guard",
            3
          ],
          "destination": [
            "buffer",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "guard",
            4
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
            "analysis",
            0
          ],
          "destination": [
            "packet",
            1
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
            "packet",
            2
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
            "packet",
            3
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
            "packet",
            4
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
            "packet",
            5
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
            "packet",
            6
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
            "packet",
            7
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
            "packet",
            8
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            2
          ],
          "destination": [
            "packet",
            9
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            3
          ],
          "destination": [
            "packet",
            10
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            4
          ],
          "destination": [
            "packet",
            11
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            5
          ],
          "destination": [
            "packet",
            12
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clock",
            6
          ],
          "destination": [
            "packet",
            13
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "authorize",
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
            "fixture",
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
            "start",
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
            "cancel",
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
            "report",
            0
          ],
          "destination": [
            "node",
            0
          ]
        }
      }
    ]
  }
}
