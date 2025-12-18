// src/preload/index.js
// Bridge seguro entre el proceso principal y el renderer

const { contextBridge, ipcRenderer } = require('electron');

// Exponer API segura al renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Obtener estado inicial
  getEstado: () => ipcRenderer.invoke('get-estado'),

  // Acciones
  recargar: () => ipcRenderer.invoke('recargar'),
  iniciarPolling: () => ipcRenderer.invoke('iniciar-polling'),
  detenerPolling: () => ipcRenderer.invoke('detener-polling'),

  // Configuración
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Eventos del main process
  onConectado: (callback) => {
    ipcRenderer.on('conectado', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('conectado');
  },

  onAgente: (callback) => {
    ipcRenderer.on('agente', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('agente');
  },

  onWorkspace: (callback) => {
    ipcRenderer.on('workspace', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('workspace');
  },

  onRegistradores: (callback) => {
    ipcRenderer.on('registradores', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('registradores');
  },

  onRegistradorActualizado: (callback) => {
    ipcRenderer.on('registrador-actualizado', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('registrador-actualizado');
  },

  onContadores: (callback) => {
    ipcRenderer.on('contadores', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('contadores');
  },

  onLog: (callback) => {
    ipcRenderer.on('log', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('log');
  },

  onPollingActivo: (callback) => {
    ipcRenderer.on('polling-activo', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('polling-activo');
  },
});
