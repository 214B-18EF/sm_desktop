const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SolarMonitor', {

    // ========== Statut ESP32 ==========
    GetEsp32Status : () => ipcRenderer.invoke('GetEsp32Status'),
    GetLastStatus  : () => ipcRenderer.invoke('GetLastStatus'),

    // ========== Listener mises a jour temps reel ==========
    OnStatusUpdate: (Callback) => {
        ipcRenderer.on('Esp32StatusUpdate', (Event, Data) => Callback(Data));
    },

    RemoveStatusListener: () => {
        ipcRenderer.removeAllListeners('Esp32StatusUpdate');
    },

    // ========== Infos app ==========
    Platform  : process.platform,
    AppVersion: process.env.npm_package_version || '1.0.0'
});
