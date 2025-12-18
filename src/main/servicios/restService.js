// src/main/servicios/restService.js
// Servicio de comunicación REST con el backend

// Configuración (se establece desde main/index.js)
let BACKEND_URL = 'http://localhost:3001';
let CLAVE_SECRETA = null;

const CONFIG_POLL_INTERVAL = 10000; // 10 segundos
const TESTS_POLL_INTERVAL = 5000;   // 5 segundos
const HEARTBEAT_INTERVAL = 30000;   // 30 segundos

// Estado del servicio
let token = null;
let agenteData = null;
let workspacesData = [];
let conectado = false;
let heartbeatIntervalId = null;
let configPollIntervalId = null;
let testsPollIntervalId = null;

// Callbacks para eventos
let callbacks = {
  onConectado: null,
  onAutenticado: null,
  onDesconectado: null,
  onError: null,
  onLog: null,
  onVinculado: null,
  onConfiguracionCambiada: null,
  onTestPendiente: null,
};

let ultimaConfigHash = null;

function log(mensaje, tipo = 'info') {
  if (callbacks.onLog) {
    callbacks.onLog(mensaje, tipo);
  } else {
    console.log(`[REST] ${mensaje}`);
  }
}

/**
 * Configura las credenciales del servicio
 */
function configurar(config) {
  if (config.backendUrl) BACKEND_URL = config.backendUrl;
  if (config.claveSecreta) CLAVE_SECRETA = config.claveSecreta;
}

async function fetchBackend(endpoint, options = {}) {
  const url = `${BACKEND_URL}/api${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token && !endpoint.includes('/agente/auth')) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401 && data.code === 'TOKEN_EXPIRED') {
        log('Token expirado, re-autenticando...', 'advertencia');
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
      if (callbacks.onDesconectado) {
        callbacks.onDesconectado('Sin conexión al backend');
      }
    }
    throw error;
  }
}

async function autenticar() {
  if (!CLAVE_SECRETA) {
    log('ERROR: Falta la clave secreta', 'error');
    return false;
  }

  try {
    log('Autenticando agente...', 'info');

    const data = await fetchBackend('/agente/auth', {
      method: 'POST',
      body: JSON.stringify({ claveSecreta: CLAVE_SECRETA }),
    });

    if (data.exito) {
      token = data.token;
      agenteData = data.agente;
      workspacesData = data.workspaces || [];
      conectado = true;

      log(`Autenticado como: ${agenteData.nombre}`, 'exito');

      if (data.advertencia) {
        log(`ADVERTENCIA: ${data.advertencia}`, 'advertencia');
      }

      return true;
    } else {
      log(`Error de autenticación: ${data.error}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Error conectando al backend: ${error.message}`, 'error');
    return false;
  }
}

async function enviarHeartbeat() {
  if (!token) return;

  try {
    await fetchBackend('/agente/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.0' }),
    });
  } catch (error) {
    log(`Error en heartbeat: ${error.message}`, 'advertencia');
  }
}

async function obtenerConfiguracion(esInicial = false) {
  if (!token) {
    throw new Error('No autenticado');
  }

  const data = await fetchBackend('/agente/config', {
    method: 'GET',
  });

  if (esInicial && data.registradores) {
    ultimaConfigHash = hashConfiguracion(data.registradores);
    log('Hash de configuración inicial establecido', 'info');
  }

  return data;
}

async function enviarLecturas(lecturas) {
  if (!token) {
    throw new Error('No autenticado');
  }

  if (!lecturas || lecturas.length === 0) {
    return { ok: true, insertadas: 0 };
  }

  const data = await fetchBackend('/agente/lecturas', {
    method: 'POST',
    body: JSON.stringify({ lecturas }),
  });

  return data;
}

async function enviarLog(nivel, mensaje, metadata = {}) {
  if (!token) return;

  try {
    await fetchBackend('/agente/log', {
      method: 'POST',
      body: JSON.stringify({ nivel, mensaje, metadata }),
    });
  } catch (error) {
    console.error('[REST] Error enviando log:', error.message);
  }
}

async function obtenerTestsPendientes() {
  if (!token) {
    throw new Error('No autenticado');
  }

  const data = await fetchBackend('/agente/tests-pendientes', {
    method: 'GET',
  });

  return data || [];
}

async function reportarResultadoTest(testId, resultado) {
  if (!token) {
    throw new Error('No autenticado');
  }

  const data = await fetchBackend(`/agente/tests/${testId}/resultado`, {
    method: 'POST',
    body: JSON.stringify(resultado),
  });

  return data;
}

async function vincularWorkspace(codigo) {
  if (!token) {
    throw new Error('No autenticado');
  }

  const data = await fetchBackend('/agente/vincular', {
    method: 'POST',
    body: JSON.stringify({ codigo }),
  });

  if (data.exito && data.workspace) {
    workspacesData.push(data.workspace);
    if (callbacks.onVinculado) {
      callbacks.onVinculado(data.workspace);
    }
  }

  return data;
}

function hashConfiguracion(registradores) {
  const ordenados = [...registradores].sort((a, b) => {
    const idA = a.id || '';
    const idB = b.id || '';
    return idA.localeCompare(idB);
  });

  return JSON.stringify(ordenados.map(r => ({
    id: r.id,
    activo: r.activo,
    intervaloSegundos: r.intervaloSegundos,
    ip: r.ip,
    puerto: r.puerto,
    indiceInicial: r.indiceInicial,
    cantidadRegistros: r.cantidadRegistros,
  })));
}

async function pollConfiguracion() {
  if (!token) return;

  try {
    const config = await obtenerConfiguracion();
    const registradores = config.registradores || [];
    const nuevoHash = hashConfiguracion(registradores);

    if (ultimaConfigHash !== null && ultimaConfigHash !== nuevoHash) {
      log('Cambio en configuración detectado', 'info');
      if (callbacks.onConfiguracionCambiada) {
        callbacks.onConfiguracionCambiada(registradores);
      }
    }

    ultimaConfigHash = nuevoHash;
  } catch (error) {
    log(`Error obteniendo configuración: ${error.message}`, 'advertencia');
  }
}

function iniciarHeartbeat() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
  }

  enviarHeartbeat();
  heartbeatIntervalId = setInterval(enviarHeartbeat, HEARTBEAT_INTERVAL);
  log('Heartbeat iniciado (cada 30s)', 'info');
}

function iniciarConfigPolling() {
  if (configPollIntervalId) {
    clearInterval(configPollIntervalId);
  }

  configPollIntervalId = setInterval(pollConfiguracion, CONFIG_POLL_INTERVAL);
  log(`Polling de configuración iniciado (cada ${CONFIG_POLL_INTERVAL / 1000}s)`, 'ciclo');
}

async function pollTestsPendientes() {
  if (!token) return;

  try {
    const tests = await obtenerTestsPendientes();

    if (tests && tests.length > 0) {
      for (const test of tests) {
        log(`Test de conexión pendiente recibido: ${test.ip}:${test.puerto}`, 'info');

        if (callbacks.onTestPendiente) {
          callbacks.onTestPendiente(test);
        }
      }
    }
  } catch (error) {
    if (!error.message.includes('No autenticado')) {
      log(`Error obteniendo tests pendientes: ${error.message}`, 'advertencia');
    }
  }
}

function iniciarTestsPolling() {
  if (testsPollIntervalId) {
    clearInterval(testsPollIntervalId);
  }

  testsPollIntervalId = setInterval(pollTestsPendientes, TESTS_POLL_INTERVAL);
  log(`Polling de tests iniciado (cada ${TESTS_POLL_INTERVAL / 1000}s)`, 'ciclo');
}

function detenerIntervalos() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  if (configPollIntervalId) {
    clearInterval(configPollIntervalId);
    configPollIntervalId = null;
  }
  if (testsPollIntervalId) {
    clearInterval(testsPollIntervalId);
    testsPollIntervalId = null;
  }
}

async function iniciarConexion(opciones = {}) {
  if (opciones.onConectado) callbacks.onConectado = opciones.onConectado;
  if (opciones.onAutenticado) callbacks.onAutenticado = opciones.onAutenticado;
  if (opciones.onDesconectado) callbacks.onDesconectado = opciones.onDesconectado;
  if (opciones.onError) callbacks.onError = opciones.onError;
  if (opciones.onLog) callbacks.onLog = opciones.onLog;
  if (opciones.onVinculado) callbacks.onVinculado = opciones.onVinculado;
  if (opciones.onRegistradoresActualizar) callbacks.onConfiguracionCambiada = opciones.onRegistradoresActualizar;
  if (opciones.onTestPendiente) callbacks.onTestPendiente = opciones.onTestPendiente;

  log(`Conectando a backend: ${BACKEND_URL}`, 'info');

  const exito = await autenticar();

  if (exito) {
    if (callbacks.onConectado) callbacks.onConectado();
    if (callbacks.onAutenticado) callbacks.onAutenticado(agenteData);

    if (workspacesData.length > 0 && callbacks.onVinculado) {
      callbacks.onVinculado(workspacesData[0]);
    }

    iniciarHeartbeat();
    iniciarConfigPolling();
    iniciarTestsPolling();
  } else {
    if (callbacks.onError) {
      callbacks.onError(new Error('No se pudo autenticar'));
    }
  }

  return exito;
}

function cerrarConexion() {
  detenerIntervalos();
  token = null;
  agenteData = null;
  conectado = false;
  ultimaConfigHash = null;
  log('Conexión REST cerrada', 'info');
}

function estaConectado() {
  return conectado && token !== null;
}

function estaAutenticado() {
  return token !== null && agenteData !== null;
}

function obtenerDatosAgente() {
  return agenteData;
}

function obtenerWorkspaces() {
  return workspacesData;
}

module.exports = {
  configurar,
  iniciarConexion,
  cerrarConexion,
  estaConectado,
  estaAutenticado,
  obtenerDatosAgente,
  obtenerWorkspaces,
  obtenerConfiguracion,
  enviarLecturas,
  enviarLog,
  vincularWorkspace,
  reportarResultadoTest,
};
