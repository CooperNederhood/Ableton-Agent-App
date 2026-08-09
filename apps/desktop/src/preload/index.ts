import { contextBridge, ipcRenderer } from "electron";

import { createDesktopApi } from "./api.js";

contextBridge.exposeInMainWorld("desktop", createDesktopApi(ipcRenderer));
