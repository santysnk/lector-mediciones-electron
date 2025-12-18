// src/main/index.js
// Punto de entrada del proceso principal de Electron
// Todo el código del agente consolidado en un solo archivo

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const ModbusRTU = require('modbus-serial');

// Cargar variables de entorno
const envPath = path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath, quiet: true });

// ============================================================================
// CLIENTE MODBUS
// ============================================================================

async function leerRegistrosModbus({ ip, puerto, indiceInicial, cantRegistros, unitId = 1 }) {
  const inicio = Number(indiceInicial);
  const cantidad = Number(cantRegistros);
  const puertoNum = Number(puerto);

  if (!ip || !puertoNum || Number.isNaN(inicio) || Number.isNaN(cantidad) || cantidad <= 0) {
    console.warn(`[Modbus] Parámetros inválidos`);
    return null;
  }

  const cliente = new ModbusRTU();

  try {
    await cliente.connectTCP(ip, { port: puertoNum });
    cliente.setID(unitId);
    cliente.setTimeout(5000);
    const respuesta = await cliente.readHoldingRegisters(inicio, cantidad);
    return respuesta.data;
  } catch (error) {
    console.error(`[Modbus] Error leyendo ${ip}:${puertoNum} - ${error.message}`);
    throw error;
  } finally {
    try { cliente.close(); } catch (e) { }
  }
}

async function testConexionModbus({ ip, puerto, unitId = 1, indiceInicial = 0, cantRegistros = 10 }) {
  const puertoNum = Number(puerto);
  const inicio = Number(indiceInicial) || 0;
  const cantidad = Number(cantRegistros) || 10;

  if (!ip || !puertoNum) {
    return { exito: false, error: 'IP y puerto son requeridos' };
  }

  const cliente = new ModbusRTU();
  const tiempoInicio = Date.now();

  try {
    await cliente.connectTCP(ip, { port: puertoNum });
    cliente.setID(unitId);
    cliente.setTimeout(5000);
    const respuesta = await cliente.readHoldingRegisters(inicio, cantidad);
    const tiempoMs = Date.now() - tiempoInicio;
    const registros = respuesta.data.map((valor, i) => ({ indice: i, direccion: inicio + i, valor }));
    return { exito: true, tiempoMs, mensaje: `Conexión exitosa en ${tiempoMs}ms`, registros };
  } catch (error) {
    return { exito: false, error: error.message || 'Error desconocido', tiempoMs: Date.now() - tiempoInicio };
  } finally {
    try { cliente.close(); } catch (e) { }
  }
}

// ============================================================================
// SERVICIO REST
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const CLAVE_SECRETA = process.env.CLAVE_SECRETA;
const CONFIG_POLL_INTERVAL = 10000;
const TESTS_POLL_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 30000;

let token = null;
let agenteData = null;
let workspacesData = [];
let conectado = false;
let heartbeatIntervalId = null;
let configPollIntervalId = null;
let testsPollIntervalId = null;
let restCallbacks = {};
let ultimaConfigHash = null;

function restLog(mensaje, tipo = 'info') {
  if (restCallbacks.onLog) restCallbacks.onLog(mensaje, tipo);
}

async function fetchBackend(endpoint, options = {}) {
  const url = `${BACKEND_URL}/api${endpoint}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  if (token && !endpoint.includes('/agente/auth')) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { ...options, headers });
    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401 && data.code === 'TOKEN_EXPIRED') {
        restLog('Token expirado, re-autenticando...', 'advertencia');
        const reauth = await autenticar();
        if (reauth) {
          headers['Authorization'] = `Bearer ${token}`;
          const retryResponse = await fetch(url, { ...options, headers });
          return await retryResponse.json();
        }
      }
      throw new Error(data.error || `Error HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
      conectado = false;
      if (restCallbacks.onDesconectado) restCallbacks.onDesconectado('Sin conexión al backend');
    }
    throw error;
  }
}

async function autenticar() {
  if (!CLAVE_SECRETA) {
    restLog('ERROR: Falta la clave secreta', 'error');
    return false;
  }

  try {
    restLog('Autenticando agente...', 'info');
    const data = await fetchBackend('/agente/auth', {
      method: 'POST',
      body: JSON.stringify({ claveSecreta: CLAVE_SECRETA }),
    });

    if (data.exito) {
      token = data.token;
      agenteData = data.agente;
      workspacesData = data.workspaces || [];
      conectado = true;
      restLog(`Autenticado como: ${agenteData.nombre}`, 'exito');
      return true;
    } else {
      restLog(`Error de autenticación: ${data.error}`, 'error');
      return false;
    }
  } catch (error) {
    restLog(`Error conectando: ${error.message}`, 'error');
    return false;
  }
}

async function enviarHeartbeat() {
  if (!token) return;
  try {
    await fetchBackend('/agente/heartbeat', { method: 'POST', body: JSON.stringify({ version: '1.0.0' }) });
  } catch (error) {
    restLog(`Error heartbeat: ${error.message}`, 'advertencia');
  }
}

async function obtenerConfiguracion(esInicial = false) {
  if (!token) throw new Error('No autenticado');
  const data = await fetchBackend('/agente/config', { method: 'GET' });
  if (esInicial && data.registradores) {
    ultimaConfigHash = hashConfiguracion(data.registradores);
  }
  return data;
}

async function enviarLecturas(lecturas) {
  if (!token) throw new Error('No autenticado');
  if (!lecturas || lecturas.length === 0) return { ok: true, insertadas: 0 };
  return await fetchBackend('/agente/lecturas', { method: 'POST', body: JSON.stringify({ lecturas }) });
}

async function obtenerTestsPendientes() {
  if (!token) throw new Error('No autenticado');
  return await fetchBackend('/agente/tests-pendientes', { method: 'GET' }) || [];
}

async function reportarResultadoTest(testId, resultado) {
  if (!token) throw new Error('No autenticado');
  return await fetchBackend(`/agente/tests/${testId}/resultado`, { method: 'POST', body: JSON.stringify(resultado) });
}

function hashConfiguracion(registradores) {
  const ordenados = [...registradores].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  return JSON.stringify(ordenados.map(r => ({
    id: r.id, activo: r.activo, intervaloSegundos: r.intervaloSegundos,
    ip: r.ip, puerto: r.puerto, indiceInicial: r.indiceInicial, cantidadRegistros: r.cantidadRegistros,
  })));
}

async function pollConfiguracion() {
  if (!token) return;
  try {
    const config = await obtenerConfiguracion();
    const registradores = config.registradores || [];
    const nuevoHash = hashConfiguracion(registradores);
    if (ultimaConfigHash !== null && ultimaConfigHash !== nuevoHash) {
      restLog('Cambio en configuración detectado', 'info');
      if (restCallbacks.onConfiguracionCambiada) restCallbacks.onConfiguracionCambiada(registradores);
    }
    ultimaConfigHash = nuevoHash;
  } catch (error) {
    restLog(`Error config: ${error.message}`, 'advertencia');
  }
}

async function pollTestsPendientes() {
  if (!token) return;
  try {
    const tests = await obtenerTestsPendientes();
    if (tests && tests.length > 0) {
      for (const test of tests) {
        restLog(`Test pendiente: ${test.ip}:${test.puerto}`, 'info');
        if (restCallbacks.onTestPendiente) restCallbacks.onTestPendiente(test);
      }
    }
  } catch (error) {
    if (!error.message.includes('No autenticado')) {
      restLog(`Error tests: ${error.message}`, 'advertencia');
    }
  }
}

function iniciarHeartbeat() {
  if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
  enviarHeartbeat();
  heartbeatIntervalId = setInterval(enviarHeartbeat, HEARTBEAT_INTERVAL);
}

function iniciarConfigPolling() {
  if (configPollIntervalId) clearInterval(configPollIntervalId);
  configPollIntervalId = setInterval(pollConfiguracion, CONFIG_POLL_INTERVAL);
}

function iniciarTestsPolling() {
  if (testsPollIntervalId) clearInterval(testsPollIntervalId);
  testsPollIntervalId = setInterval(pollTestsPendientes, TESTS_POLL_INTERVAL);
}

function detenerIntervalosRest() {
  if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }
  if (configPollIntervalId) { clearInterval(configPollIntervalId); configPollIntervalId = null; }
  if (testsPollIntervalId) { clearInterval(testsPollIntervalId); testsPollIntervalId = null; }
}

async function iniciarConexion(opciones = {}) {
  restCallbacks = opciones;
  restLog(`Conectando a: ${BACKEND_URL}`, 'info');

  const exito = await autenticar();
  if (exito) {
    if (restCallbacks.onConectado) restCallbacks.onConectado();
    if (restCallbacks.onAutenticado) restCallbacks.onAutenticado(agenteData);
    if (workspacesData.length > 0 && restCallbacks.onVinculado) restCallbacks.onVinculado(workspacesData[0]);
    iniciarHeartbeat();
    iniciarConfigPolling();
    iniciarTestsPolling();
  } else {
    if (restCallbacks.onError) restCallbacks.onError(new Error('No se pudo autenticar'));
  }
  return exito;
}

function cerrarConexion() {
  detenerIntervalosRest();
  token = null;
  agenteData = null;
  conectado = false;
  ultimaConfigHash = null;
}

// ============================================================================
// POLLING MANAGER
// ============================================================================

let registradoresCache = [];
let cicloActivo = false;
let intervalosLectura = new Map();
let contadoresProxLectura = new Map();
let contadoresLecturas = new Map(); // { regId: { exitosas: 0, fallidas: 0 } }
let contadorIntervalId = null;
let testsEnProceso = new Set();
let pollingCallbacks = {};

function pollingLog(mensaje, tipo = 'info', registradorId = null) {
  if (pollingCallbacks.onLog) pollingCallbacks.onLog(mensaje, tipo, registradorId);
}

function notificarCambio(tipo, datos) {
  if (pollingCallbacks.onEstadoCambiado) pollingCallbacks.onEstadoCambiado(tipo, datos);
}

async function cargarRegistradores() {
  if (!agenteData || !agenteData.id) {
    pollingLog('No hay agente autenticado', 'advertencia');
    return [];
  }

  pollingLog('Cargando registradores...', 'info');

  try {
    const esInicial = registradoresCache.length === 0;
    const config = await obtenerConfiguracion(esInicial);
    const registradores = config.registradores || [];

    if (registradores.length === 0) {
      pollingLog('No hay registradores configurados', 'advertencia');
    } else {
      const activos = registradores.filter(r => r.activo !== false).length;
      pollingLog(`${registradores.length} registrador(es) (${activos} activos)`, 'exito');
    }

    registradoresCache = registradores.map(r => ({
      id: r.id, nombre: r.nombre, tipo: r.tipo, ip: r.ip, puerto: r.puerto,
      unit_id: r.unitId, indice_inicial: r.indiceInicial, cantidad_registros: r.cantidadRegistros,
      intervalo_segundos: r.intervaloSegundos, timeout_ms: r.timeoutMs,
      activo: r.activo !== false, alimentador: r.alimentador,
      estado: r.activo !== false ? 'activo' : 'inactivo', proximaLectura: null,
    }));

    notificarCambio('registradores', registradoresCache);
    return registradoresCache;
  } catch (error) {
    pollingLog(`Error cargando: ${error.message}`, 'error');
    return [];
  }
}

function incrementarContadorLectura(regId, tipo) {
  if (!contadoresLecturas.has(regId)) {
    contadoresLecturas.set(regId, { exitosas: 0, fallidas: 0 });
  }
  const contadores = contadoresLecturas.get(regId);
  if (tipo === 'exitosa') {
    contadores.exitosas++;
  } else {
    contadores.fallidas++;
  }
  // Actualizar el registrador en cache
  const reg = registradoresCache.find(r => r.id === regId);
  if (reg) {
    reg.lecturasExitosas = contadores.exitosas;
    reg.lecturasFallidas = contadores.fallidas;
  }
}

async function leerRegistrador(registrador) {
  const inicio = Date.now();
  try {
    actualizarEstadoReg(registrador.id, 'leyendo');

    const valores = await leerRegistrosModbus({
      ip: registrador.ip, puerto: registrador.puerto,
      indiceInicial: registrador.indice_inicial, cantRegistros: registrador.cantidad_registros,
      unitId: registrador.unit_id || 1,
    });

    const tiempoMs = Date.now() - inicio;
    const resultado = await enviarLecturas([{
      registradorId: registrador.id, valores: Array.from(valores),
      tiempoMs, exito: true, timestamp: new Date().toISOString(),
    }]);

    if (resultado.ok) {
      incrementarContadorLectura(registrador.id, 'exitosa');
      actualizarEstadoReg(registrador.id, 'activo');
      pollingLog(`${registrador.nombre}: ${valores.length} regs (${tiempoMs}ms)`, 'exito', registrador.id);
    } else {
      incrementarContadorLectura(registrador.id, 'fallida');
      actualizarEstadoReg(registrador.id, 'error');
      pollingLog(`${registrador.nombre}: Error enviando`, 'error', registrador.id);
    }
    return { exito: true, valores };
  } catch (error) {
    const tiempoMs = Date.now() - inicio;
    try {
      await enviarLecturas([{
        registradorId: registrador.id, valores: [], tiempoMs,
        exito: false, error: error.message, timestamp: new Date().toISOString(),
      }]);
    } catch (e) { }
    incrementarContadorLectura(registrador.id, 'fallida');
    actualizarEstadoReg(registrador.id, 'error');
    pollingLog(`${registrador.nombre}: ${error.message}`, 'error', registrador.id);
    return { exito: false, error: error.message };
  }
}

function actualizarEstadoReg(regId, estado, proximaLectura = null) {
  const reg = registradoresCache.find(r => r.id === regId);
  if (reg) {
    reg.estado = estado;
    if (proximaLectura !== null) reg.proximaLectura = proximaLectura;
    notificarCambio('registrador', {
      id: regId,
      estado,
      proximaLectura: reg.proximaLectura,
      lecturasExitosas: reg.lecturasExitosas || 0,
      lecturasFallidas: reg.lecturasFallidas || 0,
    });
  }
}

function iniciarPolling() {
  if (cicloActivo) return;
  if (registradoresCache.length === 0) {
    pollingLog('No hay registradores', 'advertencia');
    return;
  }

  cicloActivo = true;
  const registradoresActivos = registradoresCache.filter(r => r.activo);

  if (registradoresActivos.length === 0) {
    pollingLog('No hay registradores activos', 'advertencia');
    return;
  }

  // Calcular delay escalonado global:
  // promedio de intervalos / cantidad de registradores, redondeado hacia arriba
  const sumaIntervalos = registradoresActivos.reduce((sum, r) => sum + (r.intervalo_segundos || 60), 0);
  const promedioIntervalo = sumaIntervalos / registradoresActivos.length;
  const delayEntreRegistradores = Math.ceil(promedioIntervalo / registradoresActivos.length);

  pollingLog(`Iniciando polling de ${registradoresActivos.length} registrador(es) con ${delayEntreRegistradores}s entre cada uno...`, 'ciclo');

  // Iniciar cada registrador con delay escalonado
  registradoresActivos.forEach((reg, index) => {
    const intervaloSegundos = reg.intervalo_segundos || 60;
    const intervaloMs = intervaloSegundos * 1000;
    const delayInicialMs = index * delayEntreRegistradores * 1000;
    const delayInicialSegundos = index * delayEntreRegistradores;

    // Establecer contador inicial (delay + intervalo para los que esperan)
    const proximaLectura = delayInicialSegundos > 0 ? delayInicialSegundos : intervaloSegundos;
    contadoresProxLectura.set(reg.id, proximaLectura);
    actualizarEstadoReg(reg.id, 'activo', proximaLectura);

    if (delayInicialMs > 0) {
      pollingLog(`${reg.nombre}: primera lectura en ${delayInicialSegundos}s`, 'info');
      setTimeout(() => {
        if (!cicloActivo) return;
        const regActual = registradoresCache.find(r => r.id === reg.id);
        if (regActual && regActual.activo) {
          leerRegistrador(regActual);
          contadoresProxLectura.set(reg.id, intervaloSegundos);
          actualizarEstadoReg(reg.id, 'activo', intervaloSegundos);
        }
      }, delayInicialMs);
    } else {
      // Primer registrador lee inmediatamente
      leerRegistrador(reg);
      contadoresProxLectura.set(reg.id, intervaloSegundos);
    }

    // Configurar intervalo para lecturas subsiguientes
    // El intervalo empieza después del delay inicial
    setTimeout(() => {
      if (!cicloActivo) return;
      const intervalId = setInterval(() => {
        if (cicloActivo) {
          const regActual = registradoresCache.find(r => r.id === reg.id);
          if (regActual && regActual.activo) {
            leerRegistrador(regActual);
            contadoresProxLectura.set(reg.id, intervaloSegundos);
            actualizarEstadoReg(reg.id, 'activo', intervaloSegundos);
          }
        }
      }, intervaloMs);
      intervalosLectura.set(reg.id, intervalId);
    }, delayInicialMs);
  });

  asegurarContadorGlobal();
  notificarCambio('pollingActivo', true);
}

function asegurarContadorGlobal() {
  if (contadorIntervalId) return;
  contadorIntervalId = setInterval(() => {
    contadoresProxLectura.forEach((segundos, regId) => {
      if (segundos > 0) {
        const nuevoValor = segundos - 1;
        contadoresProxLectura.set(regId, nuevoValor);
        const reg = registradoresCache.find(r => r.id === regId);
        if (reg) reg.proximaLectura = nuevoValor;
      }
    });
    notificarCambio('contadores', Object.fromEntries(contadoresProxLectura));
  }, 1000);
}

function detenerPolling() {
  cicloActivo = false;
  intervalosLectura.forEach(intervalId => clearInterval(intervalId));
  intervalosLectura.clear();
  contadoresProxLectura.clear();
  if (contadorIntervalId) { clearInterval(contadorIntervalId); contadorIntervalId = null; }
  pollingLog('Polling detenido', 'advertencia');
  notificarCambio('pollingActivo', false);
}

async function actualizarRegistradoresGranular(registradoresNuevos) {
  if (!registradoresNuevos) return;

  const nuevosTransformados = registradoresNuevos.map(r => ({
    id: r.id, nombre: r.nombre, tipo: r.tipo, ip: r.ip, puerto: r.puerto,
    unit_id: r.unitId, indice_inicial: r.indiceInicial, cantidad_registros: r.cantidadRegistros,
    intervalo_segundos: r.intervaloSegundos, timeout_ms: r.timeoutMs,
    activo: r.activo !== false, alimentador: r.alimentador,
    estado: r.activo !== false ? 'activo' : 'inactivo', proximaLectura: null,
  }));

  const idsNuevos = new Set(nuevosTransformados.map(r => r.id));
  const idsActuales = new Set(registradoresCache.map(r => r.id));

  for (const regActual of registradoresCache) {
    if (!idsNuevos.has(regActual.id)) {
      pollingLog(`Eliminado: ${regActual.nombre}`, 'advertencia');
      const intervalId = intervalosLectura.get(regActual.id);
      if (intervalId) { clearInterval(intervalId); intervalosLectura.delete(regActual.id); }
      contadoresProxLectura.delete(regActual.id);
    }
  }

  for (const regNuevo of nuevosTransformados) {
    const regActual = registradoresCache.find(r => r.id === regNuevo.id);
    if (!idsActuales.has(regNuevo.id)) {
      pollingLog(`Nuevo: ${regNuevo.nombre}`, 'info');
      if (regNuevo.activo && cicloActivo) iniciarPollingIndividual(regNuevo);
    } else if (regActual) {
      if (regActual.activo && !regNuevo.activo) {
        pollingLog(`Desactivado: ${regNuevo.nombre}`, 'advertencia');
        const intervalId = intervalosLectura.get(regNuevo.id);
        if (intervalId) { clearInterval(intervalId); intervalosLectura.delete(regNuevo.id); }
        contadoresProxLectura.delete(regNuevo.id);
      } else if (!regActual.activo && regNuevo.activo && cicloActivo) {
        pollingLog(`Activado: ${regNuevo.nombre}`, 'exito');
        iniciarPollingIndividual(regNuevo);
      }
    }
  }

  registradoresCache = nuevosTransformados;
  notificarCambio('registradores', registradoresCache);
}

function iniciarPollingIndividual(reg) {
  if (!reg.activo) return;
  const intervaloSegundos = reg.intervalo_segundos || 60;
  const intervaloMs = intervaloSegundos * 1000;

  contadoresProxLectura.set(reg.id, intervaloSegundos);
  actualizarEstadoReg(reg.id, 'activo', intervaloSegundos);
  leerRegistrador(reg);

  const intervalId = setInterval(() => {
    if (cicloActivo) {
      const regActual = registradoresCache.find(r => r.id === reg.id);
      if (regActual && regActual.activo) {
        leerRegistrador(regActual);
        contadoresProxLectura.set(reg.id, intervaloSegundos);
        actualizarEstadoReg(reg.id, 'activo', intervaloSegundos);
      }
    }
  }, intervaloMs);

  intervalosLectura.set(reg.id, intervalId);
  asegurarContadorGlobal();
}

async function ejecutarTestConexion(test) {
  if (testsEnProceso.has(test.id)) return;
  testsEnProceso.add(test.id);

  pollingLog(`Test: ${test.ip}:${test.puerto}`, 'ciclo');

  try {
    const resultado = await testConexionModbus({
      ip: test.ip, puerto: test.puerto, unitId: test.unit_id || 1,
      indiceInicial: test.indice_inicial, cantRegistros: test.cantidad_registros,
    });

    if (resultado.exito) {
      pollingLog(`Test OK: ${resultado.tiempoMs}ms`, 'exito');
      await reportarResultadoTest(test.id, {
        exito: true, tiempoRespuestaMs: resultado.tiempoMs,
        valores: resultado.registros.map(r => r.valor),
      });
    } else {
      pollingLog(`Test FAIL: ${resultado.error}`, 'error');
      await reportarResultadoTest(test.id, {
        exito: false, tiempoRespuestaMs: resultado.tiempoMs, errorMensaje: resultado.error,
      });
    }
  } catch (error) {
    pollingLog(`Test error: ${error.message}`, 'error');
    try { await reportarResultadoTest(test.id, { exito: false, errorMensaje: error.message }); } catch (e) { }
  } finally {
    testsEnProceso.delete(test.id);
  }
}

// ============================================================================
// ELECTRON APP
// ============================================================================

let mainWindow = null;
let tray = null;
let tiempoInicio = Date.now();

let estadoApp = {
  conectado: false,
  agente: null,
  workspace: null,
  registradores: [],
  logs: [],
  pollingActivo: false,
};

const MAX_LOGS = 100;

function agregarLog(mensaje, tipo = 'info', registradorId = null) {
  const timestamp = new Date().toLocaleTimeString();
  const log = { timestamp, mensaje, tipo, registradorId };
  estadoApp.logs.unshift(log);
  if (estadoApp.logs.length > MAX_LOGS) estadoApp.logs.pop();
  enviarARenderer('log', log);
}

function enviarARenderer(canal, datos) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(canal, datos);
  }
}

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: 'RelayWatch Agente',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (event) => {
    if (tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function crearTray() {
  const iconPath = path.join(__dirname, '../../resources/icon.png');
  let icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  actualizarTray();
  tray.setToolTip('RelayWatch Agente');
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

function actualizarTray() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: estadoApp.conectado ? 'Conectado' : 'Desconectado', enabled: false },
    { label: estadoApp.pollingActivo ? 'Polling: Activo' : 'Polling: Detenido', enabled: false },
    { type: 'separator' },
    { label: 'Salir', click: () => { tray = null; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

function mostrarNotificacion(titulo, cuerpo) {
  if (Notification.isSupported()) {
    new Notification({ title: titulo, body: cuerpo }).show();
  }
}

function configurarIPC() {
  ipcMain.handle('get-estado', () => ({
    ...estadoApp,
    tiempoActivo: Math.floor((Date.now() - tiempoInicio) / 1000),
  }));

  ipcMain.handle('recargar', async () => {
    agregarLog('Recargando registradores...', 'ciclo');
    detenerPolling();
    await cargarRegistradores();
    iniciarPolling();
    return { ok: true };
  });

  ipcMain.handle('iniciar-polling', () => { iniciarPolling(); return { ok: true }; });
  ipcMain.handle('detener-polling', () => { detenerPolling(); return { ok: true }; });
  ipcMain.handle('get-config', () => ({
    backendUrl: BACKEND_URL,
    claveSecreta: CLAVE_SECRETA ? '********' : null,
  }));
}

async function iniciarAgente() {
  if (!CLAVE_SECRETA) {
    agregarLog('ERROR: Falta CLAVE_SECRETA en .env', 'error');
    mostrarNotificacion('Error', 'Falta la clave secreta en .env');
    return;
  }

  pollingCallbacks = {
    onLog: (mensaje, tipo, registradorId) => agregarLog(mensaje, tipo, registradorId),
    onEstadoCambiado: (tipoCambio, datos) => {
      switch (tipoCambio) {
        case 'registradores':
          estadoApp.registradores = datos;
          enviarARenderer('registradores', datos);
          break;
        case 'registrador':
          enviarARenderer('registrador-actualizado', datos);
          break;
        case 'contadores':
          enviarARenderer('contadores', datos);
          break;
        case 'pollingActivo':
          estadoApp.pollingActivo = datos;
          actualizarTray();
          enviarARenderer('polling-activo', datos);
          break;
      }
    },
  };

  agregarLog(`Conectando a: ${BACKEND_URL}`, 'info');

  await iniciarConexion({
    onConectado: () => {
      estadoApp.conectado = true;
      actualizarTray();
      enviarARenderer('conectado', true);
      agregarLog('Conectado al backend', 'exito');
    },
    onAutenticado: async (agente) => {
      estadoApp.agente = agente;
      enviarARenderer('agente', agente);
      agregarLog(`Autenticado: ${agente.nombre}`, 'exito');
      await cargarRegistradores();
      if (registradoresCache.length > 0) iniciarPolling();
    },
    onVinculado: (workspace) => {
      estadoApp.workspace = workspace;
      enviarARenderer('workspace', workspace);
      agregarLog(`Workspace: ${workspace.nombre}`, 'exito');
    },
    onDesconectado: (reason) => {
      estadoApp.conectado = false;
      actualizarTray();
      enviarARenderer('conectado', false);
      agregarLog(`Desconectado: ${reason}`, 'advertencia');
      mostrarNotificacion('Desconectado', reason);
    },
    onError: (error) => agregarLog(`Error: ${error.message}`, 'error'),
    onLog: (mensaje, tipo) => agregarLog(`[REST] ${mensaje}`, tipo),
    onConfiguracionCambiada: async (regs) => await actualizarRegistradoresGranular(regs),
    onTestPendiente: (test) => ejecutarTestConexion(test),
  });
}

app.whenReady().then(() => {
  configurarIPC();
  crearVentana();
  crearTray();
  iniciarAgente();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', () => {
  detenerPolling();
  cerrarConexion();
});
