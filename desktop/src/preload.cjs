const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, value) => ipcRenderer.invoke(channel, value);

contextBridge.exposeInMainWorld("patchwardenDesktop", Object.freeze({
  getState: () => invoke("desktop:get-state"),
  chooseWorkspace: () => invoke("desktop:choose-workspace"),
  chooseTunnelClient: () => invoke("desktop:choose-tunnel-client"),
  detectTunnelClient: () => invoke("desktop:detect-tunnel-client"),
  detectAgents: () => invoke("desktop:detect-agents"),
  saveSetup: (value) => invoke("desktop:save-setup", value),
  runDoctor: () => invoke("desktop:run-doctor"),
  getPreferences: () => invoke("desktop:get-preferences"),
  setPreferences: (value) => invoke("desktop:set-preferences", value),
  getRuntimeSettings: () => invoke("desktop:get-runtime-settings"),
  setRuntimeSettings: (value) => invoke("desktop:set-runtime-settings", value),
  getTunnelSetupStatus: (mode) => invoke("desktop:get-tunnel-setup-status", mode),
  provisionTunnelProfile: (value) => invoke("desktop:provision-tunnel-profile", value),
  revalidateTunnelProfile: (mode) => invoke("desktop:revalidate-tunnel-profile", mode),
  forgetTunnelCredential: () => invoke("desktop:forget-tunnel-credential"),
  openPath: (kind) => invoke("desktop:open-path", kind),
}));
