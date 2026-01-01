// src/main/index.js
// Punto de entrada del proceso principal de Electron
// Todo el código del agente consolidado en un solo archivo

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ModbusRTU = require('modbus-serial');

// Cargar variables de entorno
const envPath = path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath, quiet: true });

// ============================================================================
// SISTEMA DE INSTANCIA ÚNICA
// ============================================================================

const LOCK_FILE = path.join(app.getPath('userData'), 'agent.lock');

/**
 * Verifica si un proceso con el PID dado está corriendo
 */
function procesoExiste(pid) {
  try {
    process.kill(pid, 0); // Signal 0 no mata, solo verifica
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Intenta matar un proceso por PID
 */
function matarProceso(pid) {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Crea el archivo de lock con el PID actual
 */
function crearLockFile() {
  try {
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), 'utf8');
  } catch (e) {
    console.error('[Lock] Error creando archivo de lock:', e.message);
  }
}

/**
 * Elimina el archivo de lock
 */
function eliminarLockFile() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    console.error('[Lock] Error eliminando archivo de lock:', e.message);
  }
}

/**
 * Lee el PID del archivo de lock
 */
function leerPidDeLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const contenido = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(contenido, 10);
      return isNaN(pid) ? null : pid;
    }
  } catch (e) {
    console.error('[Lock] Error leyendo archivo de lock:', e.message);
  }
  return null;
}

/**
 * Maneja el caso de instancia duplicada
 * Retorna true si se resolvió y podemos continuar, false si debemos salir
 */
async function manejarInstanciaDuplicada() {
  const pidAnterior = leerPidDeLock();

  // Si hay un PID en el lock file, verificar si ese proceso sigue corriendo
  if (pidAnterior && procesoExiste(pidAnterior)) {
    // El proceso anterior sigue corriendo - mostrar diálogo
    const resultado = await dialog.showMessageBox({
      type: 'warning',
      title: 'Agente ya en ejecución',
      message: 'Ya existe una instancia del agente en ejecución.',
      detail: `Se detectó otro proceso del agente (PID: ${pidAnterior}).\n\n¿Desea cerrar la instancia anterior e iniciar una nueva?`,
      buttons: ['Cerrar instancia anterior e iniciar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
    });

    if (resultado.response === 0) {
      // Intentar matar el proceso anterior
      const exito = matarProceso(pidAnterior);

      if (exito) {
        // Esperar un momento para que el proceso termine
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verificar que realmente murió
        if (!procesoExiste(pidAnterior)) {
          eliminarLockFile();
          return true; // Podemos continuar
        }
      }

      // No se pudo cerrar el proceso
      await dialog.showMessageBox({
        type: 'error',
        title: 'Error al cerrar instancia',
        message: 'No se pudo cerrar la instancia anterior del agente.',
        detail: `El proceso (PID: ${pidAnterior}) no pudo ser terminado.\n\nPor favor, ciérrelo manualmente desde el Administrador de Tareas y vuelva a intentar.`,
        buttons: ['Aceptar'],
      });
      return false;
    } else {
      // Usuario canceló
      return false;
    }
  } else if (pidAnterior) {
    // El PID existe en el lock pero el proceso no está corriendo (cierre incorrecto anterior)
    // Limpiar el lock file huérfano
    eliminarLockFile();
    return true;
  }

  return true; // No había lock file
}

// Solicitar lock de instancia única de Electron
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Otra instancia ya tiene el lock - manejar asincrónicamente
  app.whenReady().then(async () => {
    const puedeIniciar = await manejarInstanciaDuplicada();
    if (!puedeIniciar) {
      app.quit();
      return;
    }
    // Si llegamos aquí, el lock debería estar disponible ahora
    // pero Electron no lo reasignará, así que forzamos el inicio de todos modos
    inicializarApp();
  });
} else {
  // Tenemos el lock - configurar el listener para cuando otra instancia intente iniciar
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Otra instancia intentó iniciar - mostrar nuestra ventana
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Iniciar normalmente
  app.whenReady().then(() => {
    crearLockFile();
    inicializarApp();
  });
}

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

/**
 * Test de conexión leyendo coils (función Modbus 01)
 * Para leer estados de protecciones que usan direcciones de bits
 */
async function testConexionCoils({ ip, puerto, unitId = 1, direccionCoil = 0, cantidadBits = 16 }) {
  const puertoNum = Number(puerto);
  const direccion = Number(direccionCoil) || 0;
  const cantidad = Number(cantidadBits) || 16;

  if (!ip || !puertoNum) {
    return { exito: false, error: 'IP y puerto son requeridos' };
  }

  const cliente = new ModbusRTU();
  const tiempoInicio = Date.now();

  try {
    await cliente.connectTCP(ip, { port: puertoNum });
    cliente.setID(unitId);
    cliente.setTimeout(5000);

    // Usar función 01 (Read Coils) en lugar de función 03 (Read Holding Registers)
    const respuesta = await cliente.readCoils(direccion, cantidad);
    const tiempoMs = Date.now() - tiempoInicio;

    // respuesta.data es un array de booleanos
    const coils = respuesta.data.map((valor, i) => ({
      direccion: direccion + i,
      valor: valor ? 1 : 0
    }));

    // Identificar bits activos
    const bitsActivos = coils.filter(c => c.valor === 1).map(c => c.direccion);

    return {
      exito: true,
      tiempoMs,
      mensaje: `Lectura de coils exitosa en ${tiempoMs}ms`,
      coils,
      bitsActivos,
      tipoLectura: 'coils'
    };
  } catch (error) {
    return {
      exito: false,
      error: error.message || 'Error desconocido',
      tiempoMs: Date.now() - tiempoInicio
    };
  } finally {
    try { cliente.close(); } catch (e) { }
  }
}

// ============================================================================
// SERVICIO REST Y SSE
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const CLAVE_SECRETA = process.env.CLAVE_SECRETA;
const HEARTBEAT_INTERVAL = 30000;    // 30s - mantener
const SSE_RECONNECT_DELAY = 3000;    // 3s - delay antes de reconectar SSE (reducido para reconexión más rápida)
const SSE_MAX_SILENCE_MS = 60000;    // 60s - si no recibimos nada del servidor, reconectar

let token = null;
let agenteData = null;
let workspacesData = [];
let conectado = false;
let sseConectado = false;
let heartbeatIntervalId = null;
let sseAbortController = null;
let sseReconnectTimeoutId = null;
let sseLastActivityTime = null;
let sseSilenceCheckId = null;
let restCallbacks = {};

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
    // Si el heartbeat tuvo exito y estabamos desconectados, reconectar
    if (!conectado) {
      conectado = true;
      restLog('Conexión recuperada', 'exito');
      if (restCallbacks.onConectado) restCallbacks.onConectado();
    }
  } catch (error) {
    restLog(`Error heartbeat: ${error.message}`, 'advertencia');
  }
}

async function obtenerConfiguracion() {
  if (!token) throw new Error('No autenticado');
  return await fetchBackend('/agente/config', { method: 'GET' });
}

async function enviarLecturas(lecturas) {
  if (!token) throw new Error('No autenticado');
  if (!lecturas || lecturas.length === 0) return { ok: true, insertadas: 0 };
  return await fetchBackend('/agente/lecturas', { method: 'POST', body: JSON.stringify({ lecturas }) });
}

async function reportarResultadoTest(testId, resultado) {
  if (!token) throw new Error('No autenticado');
  return await fetchBackend(`/agente/tests/${testId}/resultado`, { method: 'POST', body: JSON.stringify(resultado) });
}

/**
 * Recarga la configuración cuando el backend notifica cambios vía SSE
 */
async function recargarConfiguracion(motivo) {
  if (!token) return;
  try {
    restLog(`Recargando configuración: ${motivo}`, 'info');
    const config = await obtenerConfiguracion();
    const registradores = config.registradores || [];
    if (restCallbacks.onConfiguracionCambiada) {
      restCallbacks.onConfiguracionCambiada(registradores);
    }
  } catch (error) {
    restLog(`Error recargando config: ${error.message}`, 'advertencia');
  }
}

// ============================================================================
// SSE (Server-Sent Events) - Recibir comandos en tiempo real
// ============================================================================

async function conectarSSE() {
  if (!token) {
    restLog('SSE: No hay token, esperando autenticación...', 'advertencia');
    return;
  }

  // Cancelar conexión anterior si existe
  if (sseAbortController) {
    sseAbortController.abort();
  }

  // Limpiar detector de silencio anterior
  if (sseSilenceCheckId) {
    clearInterval(sseSilenceCheckId);
    sseSilenceCheckId = null;
  }

  sseAbortController = new AbortController();
  const url = `${BACKEND_URL}/api/agente/eventos`;

  restLog('SSE: Conectando...', 'info');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      signal: sseAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    sseConectado = true;
    sseLastActivityTime = Date.now();
    restLog('SSE: Conectado', 'exito');

    // Iniciar detector de silencio - si no recibimos nada en 60s, forzar reconexión
    sseSilenceCheckId = setInterval(() => {
      const silencioMs = Date.now() - sseLastActivityTime;
      if (silencioMs > SSE_MAX_SILENCE_MS) {
        restLog(`SSE: Sin actividad por ${Math.round(silencioMs/1000)}s, reconectando...`, 'advertencia');
        if (sseAbortController) {
          sseAbortController.abort();
        }
      }
    }, 10000); // Verificar cada 10 segundos

    // Leer el stream de eventos
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        restLog('SSE: Conexión cerrada por el servidor', 'advertencia');
        break;
      }

      // Actualizar tiempo de última actividad con cualquier dato recibido
      sseLastActivityTime = Date.now();

      buffer += decoder.decode(value, { stream: true });

      // Procesar eventos completos (terminan con \n\n)
      const eventos = buffer.split('\n\n');
      buffer = eventos.pop() || ''; // El último puede estar incompleto

      for (const evento of eventos) {
        if (evento.trim()) {
          // Ignorar comentarios SSE (líneas que empiezan con :)
          // pero ya actualizamos sseLastActivityTime arriba
          if (!evento.startsWith(':')) {
            procesarEventoSSE(evento);
          }
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      // Verificar si fue por silencio o por cancelación intencional
      const silencioMs = sseLastActivityTime ? Date.now() - sseLastActivityTime : 0;
      if (silencioMs > SSE_MAX_SILENCE_MS) {
        restLog('SSE: Reconectando por inactividad...', 'info');
        // Continuar para reconectar
      } else {
        restLog('SSE: Conexión cancelada', 'info');
        return; // No reconectar si fue cancelado intencionalmente
      }
    } else {
      restLog(`SSE: Error - ${error.message}`, 'error');
    }
  } finally {
    sseConectado = false;
    if (sseSilenceCheckId) {
      clearInterval(sseSilenceCheckId);
      sseSilenceCheckId = null;
    }
  }

  // Reconectar después de un delay
  programarReconexionSSE();
}

function procesarEventoSSE(eventoRaw) {
  const lineas = eventoRaw.split('\n');
  let tipoEvento = 'message';
  let datos = '';

  for (const linea of lineas) {
    if (linea.startsWith('event:')) {
      tipoEvento = linea.substring(6).trim();
    } else if (linea.startsWith('data:')) {
      datos = linea.substring(5).trim();
    }
  }

  if (!datos) return;

  try {
    const datosJson = JSON.parse(datos);

    switch (tipoEvento) {
      case 'conectado':
        restLog(`SSE: ${datosJson.mensaje}`, 'exito');
        break;

      case 'heartbeat':
        // Heartbeat del servidor, ignorar silenciosamente
        break;

      case 'test-registrador':
        restLog(`SSE: Test recibido para ${datosJson.ip}:${datosJson.puerto}`, 'info');
        if (restCallbacks.onTestPendiente) {
          // Transformar al formato esperado por ejecutarTestConexion
          restCallbacks.onTestPendiente({
            id: datosJson.testId,
            ip: datosJson.ip,
            puerto: datosJson.puerto,
            unit_id: datosJson.unitId,
            indice_inicial: datosJson.indiceInicial,
            cantidad_registros: datosJson.cantidadRegistros,
          });
        }
        break;

      case 'test-coils':
        restLog(`SSE: Test coils recibido para ${datosJson.ip}:${datosJson.puerto} dir:${datosJson.direccionCoil}`, 'info');
        if (restCallbacks.onTestCoilsPendiente) {
          restCallbacks.onTestCoilsPendiente({
            id: datosJson.testId,
            ip: datosJson.ip,
            puerto: datosJson.puerto,
            unit_id: datosJson.unitId,
            direccion_coil: datosJson.direccionCoil,
            cantidad_bits: datosJson.cantidadBits,
          });
        }
        break;

      case 'config-actualizada':
        restLog(`SSE: ${datosJson.motivo}`, 'info');
        recargarConfiguracion(datosJson.motivo);
        break;

      default:
        restLog(`SSE: Evento desconocido '${tipoEvento}'`, 'advertencia');
    }
  } catch (error) {
    restLog(`SSE: Error parseando evento - ${error.message}`, 'error');
  }
}

function programarReconexionSSE() {
  if (sseReconnectTimeoutId) {
    clearTimeout(sseReconnectTimeoutId);
  }

  restLog(`SSE: Reconectando en ${SSE_RECONNECT_DELAY / 1000}s...`, 'info');

  sseReconnectTimeoutId = setTimeout(() => {
    if (token && conectado) {
      conectarSSE();
    }
  }, SSE_RECONNECT_DELAY);
}

function desconectarSSE() {
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }
  if (sseReconnectTimeoutId) {
    clearTimeout(sseReconnectTimeoutId);
    sseReconnectTimeoutId = null;
  }
  if (sseSilenceCheckId) {
    clearInterval(sseSilenceCheckId);
    sseSilenceCheckId = null;
  }
  sseConectado = false;
  sseLastActivityTime = null;
}

// ============================================================================
// GESTIÓN DE INTERVALOS
// ============================================================================

function iniciarHeartbeat() {
  if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
  enviarHeartbeat();
  heartbeatIntervalId = setInterval(enviarHeartbeat, HEARTBEAT_INTERVAL);
}

function detenerIntervalosRest() {
  if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }
  desconectarSSE();
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
    // Conectar SSE para recibir comandos y notificaciones de config en tiempo real
    conectarSSE();
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
    const config = await obtenerConfiguracion();
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

/**
 * Ejecuta un test de lectura de coils (función Modbus 01)
 * Similar a ejecutarTestConexion pero para bits/coils
 */
async function ejecutarTestCoils(test) {
  if (testsEnProceso.has(test.id)) return;
  testsEnProceso.add(test.id);

  pollingLog(`Test Coils: ${test.ip}:${test.puerto} dir:${test.direccion_coil}`, 'ciclo');

  try {
    const resultado = await testConexionCoils({
      ip: test.ip,
      puerto: test.puerto,
      unitId: test.unit_id || 1,
      direccionCoil: test.direccion_coil,
      cantidadBits: test.cantidad_bits,
    });

    if (resultado.exito) {
      pollingLog(`Test Coils OK: ${resultado.tiempoMs}ms - Activos: [${resultado.bitsActivos.join(',')}]`, 'exito');
      await reportarResultadoTest(test.id, {
        exito: true,
        tiempoRespuestaMs: resultado.tiempoMs,
        coils: resultado.coils,
        bitsActivos: resultado.bitsActivos,
        tipoLectura: 'coils',
      });
    } else {
      pollingLog(`Test Coils FAIL: ${resultado.error}`, 'error');
      await reportarResultadoTest(test.id, {
        exito: false,
        tiempoRespuestaMs: resultado.tiempoMs,
        errorMensaje: resultado.error,
      });
    }
  } catch (error) {
    pollingLog(`Test Coils error: ${error.message}`, 'error');
    try {
      await reportarResultadoTest(test.id, { exito: false, errorMensaje: error.message });
    } catch (e) { }
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
  sseConectado: false,
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
    sseConectado,
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
  ipcMain.handle('cerrar-agente', () => {
    // Limpiar todo antes de cerrar
    detenerPolling();
    cerrarConexion();
    eliminarLockFile(); // Limpiar lock file
    if (tray) {
      tray.destroy();
      tray = null;
    }
    // Forzar cierre de todas las ventanas
    BrowserWindow.getAllWindows().forEach(win => win.destroy());
    app.quit();
    // Si app.quit() no cierra todo, forzar con exit
    setTimeout(() => process.exit(0), 500);
  });
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
      // No iniciar polling automaticamente - el usuario debe hacer click en "Iniciar"
      agregarLog('Listo. Presione "Iniciar" para comenzar el polling.', 'info');
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
    onTestCoilsPendiente: (test) => ejecutarTestCoils(test),
  });
}

/**
 * Función principal de inicialización de la aplicación
 * Se llama después de verificar que no hay otra instancia
 */
function inicializarApp() {
  configurarIPC();
  crearVentana();
  crearTray();
  iniciarAgente();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', () => {
  detenerPolling();
  cerrarConexion();
  eliminarLockFile(); // Limpiar lock file al cerrar
});

// También limpiar en caso de salida forzada
process.on('exit', () => {
  eliminarLockFile();
});

process.on('SIGINT', () => {
  eliminarLockFile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  eliminarLockFile();
  process.exit(0);
});
