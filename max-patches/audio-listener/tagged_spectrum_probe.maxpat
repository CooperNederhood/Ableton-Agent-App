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
          "id": "left",
          "text": "fftin~ 1 square",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            10,
            10,
            90,
            22
          ],
          "varname": "ml_fft_left"
        }
      },
      {
        "box": {
          "id": "right",
          "text": "fftin~ 2 square",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            250,
            10,
            90,
            22
          ],
          "varname": "ml_fft_right"
        }
      },
      {
        "box": {
          "id": "clock",
          "text": "fftin~ 3 nofft",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            500,
            10,
            84,
            22
          ],
          "varname": "ml_fft_clock"
        }
      },
      {
        "box": {
          "id": "clockHigh",
          "text": "fftin~ 4 nofft",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            500,
            45,
            84,
            22
          ],
          "varname": "ml_fft_clockHigh"
        }
      },
      {
        "box": {
          "id": "energy",
          "text": "gen~ tagged_spectrum_probe.gendsp @nocache 1",
          "maxclass": "newobj",
          "numinlets": 7,
          "numoutlets": 10,
          "patching_rect": [
            10,
            70,
            264,
            22
          ],
          "varname": "ml_fft_energy"
        }
      },
      {
        "box": {
          "id": "command",
          "text": "in 5",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 1,
          "patching_rect": [
            10,
            120,
            50,
            22
          ],
          "varname": "ml_fft_command"
        }
      },
      {
        "box": {
          "id": "commandRoute",
          "text": "route diagnostics",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            90,
            102,
            22
          ],
          "varname": "ml_fft_commandRoute"
        }
      },
      {
        "box": {
          "id": "diagPoll",
          "text": "trigger b b b b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 5,
          "patching_rect": [
            10,
            350,
            102,
            22
          ],
          "varname": "ml_fft_diagPoll"
        }
      },
      {
        "box": {
          "id": "diagPack",
          "text": "pack 0.125 0.125 0.125 0.125 0",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            250,
            310,
            180,
            22
          ],
          "varname": "ml_fft_diagPack"
        }
      },
      {
        "box": {
          "id": "diagPrint",
          "text": "print native-fft-clock-diagnostics",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            250,
            350,
            204,
            22
          ],
          "varname": "ml_fft_diagPrint"
        }
      },
      {
        "box": {
          "id": "infoOrder",
          "text": "trigger b b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 3,
          "patching_rect": [
            500,
            120,
            78,
            22
          ],
          "varname": "ml_fft_infoOrder"
        }
      },
      {
        "box": {
          "id": "info",
          "text": "fftinfo~",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 4,
          "patching_rect": [
            500,
            150,
            50,
            22
          ],
          "varname": "ml_fft_info"
        }
      },
      {
        "box": {
          "id": "infoPack",
          "text": "pack fft-info 0.125 0.125 0.125 0.125",
          "maxclass": "newobj",
          "numinlets": 5,
          "numoutlets": 1,
          "patching_rect": [
            500,
            270,
            222,
            22
          ],
          "varname": "ml_fft_infoPack"
        }
      },
      {
        "box": {
          "id": "infoChange",
          "text": "zl.change",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 2,
          "patching_rect": [
            500,
            310,
            54,
            22
          ],
          "varname": "ml_fft_infoChange"
        }
      },
      {
        "box": {
          "id": "infoPrint",
          "text": "print native-fft-information",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            500,
            350,
            168,
            22
          ],
          "varname": "ml_fft_infoPrint"
        }
      },
      {
        "box": {
          "id": "poll",
          "text": "trigger b b b b b b",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 6,
          "patching_rect": [
            10,
            160,
            114,
            22
          ],
          "varname": "ml_fft_poll"
        }
      },
      {
        "box": {
          "id": "pack",
          "text": "pack spectrum_frame 0.125 0.125 0.125 0.125 0.125 0",
          "maxclass": "newobj",
          "numinlets": 7,
          "numoutlets": 1,
          "patching_rect": [
            10,
            270,
            306,
            22
          ],
          "varname": "ml_fft_pack"
        }
      },
      {
        "box": {
          "id": "hot",
          "text": "trigger b f",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 2,
          "patching_rect": [
            10,
            230,
            66,
            22
          ],
          "varname": "ml_fft_hot"
        }
      },
      {
        "box": {
          "id": "out",
          "text": "out 1",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [
            10,
            320,
            50,
            22
          ],
          "varname": "ml_fft_out"
        }
      },
      {
        "box": {
          "id": "diagSnap0",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            250,
            240,
            114,
            22
          ],
          "varname": "ml_fft_diagSnap0"
        }
      },
      {
        "box": {
          "id": "diagSnap1",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            350,
            240,
            114,
            22
          ],
          "varname": "ml_fft_diagSnap1"
        }
      },
      {
        "box": {
          "id": "diagSnap2",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            450,
            240,
            114,
            22
          ],
          "varname": "ml_fft_diagSnap2"
        }
      },
      {
        "box": {
          "id": "diagSnap3",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            550,
            240,
            114,
            22
          ],
          "varname": "ml_fft_diagSnap3"
        }
      },
      {
        "box": {
          "id": "diagSnap4",
          "text": "snapshot~ @offset 0",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "patching_rect": [
            650,
            240,
            114,
            22
          ],
          "varname": "ml_fft_diagSnap4"
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
            620,
            210,
            114,
            22
          ],
          "varname": "ml_fft_snap5"
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
            520,
            210,
            114,
            22
          ],
          "varname": "ml_fft_snap4"
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
            420,
            210,
            114,
            22
          ],
          "varname": "ml_fft_snap3"
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
            320,
            210,
            114,
            22
          ],
          "varname": "ml_fft_snap2"
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
            220,
            210,
            114,
            22
          ],
          "varname": "ml_fft_snap1"
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
            120,
            210,
            114,
            22
          ],
          "varname": "ml_fft_snap0"
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
            "clock",
            1
          ],
          "destination": [
            "energy",
            5
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "clockHigh",
            1
          ],
          "destination": [
            "energy",
            6
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
            "commandRoute",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "commandRoute",
            1
          ],
          "destination": [
            "infoOrder",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "commandRoute",
            0
          ],
          "destination": [
            "diagPoll",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagPack",
            0
          ],
          "destination": [
            "diagPrint",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "infoOrder",
            2
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
            "infoOrder",
            1
          ],
          "destination": [
            "infoPack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "infoOrder",
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
            "infoPack",
            0
          ],
          "destination": [
            "infoChange",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "infoChange",
            0
          ],
          "destination": [
            "infoPrint",
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
            "out",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "hot",
            1
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
            "hot",
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
            "info",
            0
          ],
          "destination": [
            "infoPack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            1
          ],
          "destination": [
            "infoPack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            2
          ],
          "destination": [
            "infoPack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "info",
            3
          ],
          "destination": [
            "infoPack",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            5
          ],
          "destination": [
            "diagSnap0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagPoll",
            0
          ],
          "destination": [
            "diagSnap0",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagSnap0",
            0
          ],
          "destination": [
            "diagPack",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            6
          ],
          "destination": [
            "diagSnap1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagPoll",
            1
          ],
          "destination": [
            "diagSnap1",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagSnap1",
            0
          ],
          "destination": [
            "diagPack",
            1
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            7
          ],
          "destination": [
            "diagSnap2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagPoll",
            2
          ],
          "destination": [
            "diagSnap2",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagSnap2",
            0
          ],
          "destination": [
            "diagPack",
            2
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            8
          ],
          "destination": [
            "diagSnap3",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagPoll",
            3
          ],
          "destination": [
            "diagSnap3",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagSnap3",
            0
          ],
          "destination": [
            "diagPack",
            3
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            9
          ],
          "destination": [
            "diagSnap4",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagPoll",
            4
          ],
          "destination": [
            "diagSnap4",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "diagSnap4",
            0
          ],
          "destination": [
            "diagPack",
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            3
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
            "poll",
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
            1
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
            "snap4",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "poll",
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
            2
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
            "snap3",
            0
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "poll",
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
            "energy",
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
            "poll",
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
            4
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            4
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
            "poll",
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
            6
          ]
        }
      },
      {
        "patchline": {
          "source": [
            "energy",
            3
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
            "poll",
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
            "hot",
            0
          ]
        }
      }
    ]
  }
}
