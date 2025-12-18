// src/main/polling/pollingManager.js
// Gestor de polling para registradores Modbus

const { leerRegistrosModbus, testConexionModbus } = require('../modbus/clienteModbus');
const restService = require('../servicios/restService');

// Estado del polling
let registradoresCache = [];
let cicloActivo = false;
let intervalosLectura = new Map();
let contadoresProxLectura = new Map();
let contadorIntervalId = null;
let testsEnProceso = new Set();

// Callback para notificar cambios a la UI
let onEstadoCambiado = null;
let onLog = null;

/**
 * Configura los callbacks para notificaciones
 */
function configurar(opciones) {
  if (opciones.onEstadoCambiado) onEstadoCambiado = opciones.onEstadoCambiado;
  if (opciones.onLog) onLog = opciones.onLog;
}

function log(mensaje, tipo = 'info') {
  if (onLog) {
    onLog(mensaje, tipo);
  } else {
    console.log(`[Polling] ${mensaje}`);
  }
}

function notificarCambio(tipo, datos) {
  if (onEstadoCambiado) {
    onEstadoCambiado(tipo, datos);
  }
}

/**
 * Carga los registradores desde el backend
 */
async function cargarRegistradores() {
  const agente = restService.obtenerDatosAgente();

  if (!agente || !agente.id) {
    log('No hay agente autenticado para cargar registradores', 'advertencia');
    return [];
  }

  log('Cargando registradores desde el backend...', 'info');

  try {
    const esInicial = registradoresCache.length === 0;
    const config = await restService.obtenerConfiguracion(esInicial);
    const registradores = config.registradores || [];

    if (registradores.length === 0) {
      log('No hay registradores configurados para este agente', 'advertencia');
    } else {
      const activos = registradores.filter(r => r.activo !== false).length;
      log(`${registradores.length} registrador(es) cargados (${activos} activos)`, 'exito');
    }

    registradoresCache = registradores.map(r => ({
      id: r.id,
      nombre: r.nombre,
      tipo: r.tipo,
      ip: r.ip,
      puerto: r.puerto,
      unit_id: r.unitId,
      indice_inicial: r.indiceInicial,
      cantidad_registros: r.cantidadRegistros,
      intervalo_segundos: r.intervaloSegundos,
      timeout_ms: r.timeoutMs,
      activo: r.activo !== false,
      alimentador: r.alimentador,
      estado: r.activo !== false ? 'activo' : 'inactivo',
      proximaLectura: null,
    }));

    notificarCambio('registradores', registradoresCache);

    return registradoresCache;
  } catch (error) {
    log(`Error cargando registradores: ${error.message}`, 'error');
    return [];
  }
}

/**
 * Lee un registrador Modbus y envía la lectura al backend
 */
async function leerRegistrador(registrador) {
  const inicio = Date.now();

  try {
    actualizarEstadoRegistrador(registrador.id, 'leyendo');

    const valores = await leerRegistrosModbus({
      ip: registrador.ip,
      puerto: registrador.puerto,
      indiceInicial: registrador.indice_inicial,
      cantRegistros: registrador.cantidad_registros,
      unitId: registrador.unit_id || 1,
    });

    const tiempoMs = Date.now() - inicio;

    const resultado = await restService.enviarLecturas([{
      registradorId: registrador.id,
      valores: Array.from(valores),
      tiempoMs,
      exito: true,
      timestamp: new Date().toISOString(),
    }]);

    if (resultado.ok) {
      actualizarEstadoRegistrador(registrador.id, 'activo');
      log(`${registrador.nombre}: ${valores.length} registros (${tiempoMs}ms)`, 'exito');
    } else {
      actualizarEstadoRegistrador(registrador.id, 'error');
      log(`${registrador.nombre}: Error enviando lectura`, 'error');
    }

    return { exito: true, valores };

  } catch (error) {
    const tiempoMs = Date.now() - inicio;

    try {
      await restService.enviarLecturas([{
        registradorId: registrador.id,
        valores: [],
        tiempoMs,
        exito: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      }]);
    } catch (e) {
      // Ignorar errores al reportar el error
    }

    actualizarEstadoRegistrador(registrador.id, 'error');
    log(`${registrador.nombre}: ${error.message}`, 'error');
    return { exito: false, error: error.message };
  }
}

function actualizarEstadoRegistrador(regId, estado, proximaLectura = null) {
  const reg = registradoresCache.find(r => r.id === regId);
  if (reg) {
    reg.estado = estado;
    if (proximaLectura !== null) {
      reg.proximaLectura = proximaLectura;
    }
    notificarCambio('registrador', { id: regId, estado, proximaLectura: reg.proximaLectura });
  }
}

/**
 * Inicia el ciclo de polling para todos los registradores
 */
function iniciarPolling() {
  if (cicloActivo) {
    log('El ciclo de polling ya está activo', 'advertencia');
    return;
  }

  if (registradoresCache.length === 0) {
    log('No hay registradores para monitorear', 'advertencia');
    return;
  }

  cicloActivo = true;

  const registradoresActivos = registradoresCache.filter((r) => r.activo);

  if (registradoresActivos.length === 0) {
    log('No hay registradores activos para polling', 'advertencia');
    return;
  }

  log(`Iniciando polling de ${registradoresActivos.length} registrador(es) activo(s)...`, 'ciclo');

  // Agrupar por IP para escalonar
  const porIp = new Map();
  for (const reg of registradoresActivos) {
    if (!porIp.has(reg.ip)) {
      porIp.set(reg.ip, []);
    }
    porIp.get(reg.ip).push(reg);
  }

  for (const [ip, regs] of porIp) {
    if (regs.length > 1) {
      log(`IP ${ip}: ${regs.length} registradores, escalonando lecturas`, 'info');
    }

    regs.forEach((reg, index) => {
      const intervaloSegundos = reg.intervalo_segundos || 60;
      const intervaloMs = intervaloSegundos * 1000;

      const delayMs = index === 0 ? 0 : Math.floor((intervaloSegundos * 1000 * index) / regs.length);
      const delaySegundos = Math.ceil(delayMs / 1000);

      contadoresProxLectura.set(reg.id, delaySegundos || intervaloSegundos);
      actualizarEstadoRegistrador(reg.id, reg.estado, delaySegundos || intervaloSegundos);

      if (delayMs > 0) {
        setTimeout(() => {
          if (!cicloActivo) return;
          const regActual = registradoresCache.find(r => r.id === reg.id);
          if (regActual && regActual.activo) {
            leerRegistrador(regActual);
            contadoresProxLectura.set(reg.id, intervaloSegundos);
            actualizarEstadoRegistrador(reg.id, 'activo', intervaloSegundos);
          }
        }, delayMs);
      } else {
        leerRegistrador(reg);
      }

      const intervalId = setInterval(() => {
        if (cicloActivo) {
          const regActual = registradoresCache.find(r => r.id === reg.id);
          if (regActual && regActual.activo) {
            leerRegistrador(regActual);
            contadoresProxLectura.set(reg.id, intervaloSegundos);
            actualizarEstadoRegistrador(reg.id, 'activo', intervaloSegundos);
          }
        }
      }, intervaloMs);

      intervalosLectura.set(reg.id, intervalId);
    });
  }

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
        if (reg) {
          reg.proximaLectura = nuevoValor;
        }
      }
    });
    notificarCambio('contadores', Object.fromEntries(contadoresProxLectura));
  }, 1000);
}

function calcularDelayEscalonado(ip, intervaloSegundos) {
  let countMismaIp = 0;
  for (const [regId] of intervalosLectura) {
    const reg = registradoresCache.find(r => r.id === regId);
    if (reg && reg.ip === ip) {
      countMismaIp++;
    }
  }

  if (countMismaIp === 0) {
    return 0;
  }

  const delaySegundos = Math.floor(intervaloSegundos / (countMismaIp + 1));
  return delaySegundos * 1000;
}

function iniciarPollingRegistrador(reg, delayInicialMs = null) {
  if (!reg.activo) return;

  if (!cicloActivo) {
    cicloActivo = true;
    log('Ciclo de polling activado', 'ciclo');
  }
  asegurarContadorGlobal();

  const intervaloSegundos = reg.intervalo_segundos || 60;
  const intervaloMs = intervaloSegundos * 1000;

  const delayMs = delayInicialMs !== null ? delayInicialMs : calcularDelayEscalonado(reg.ip, intervaloSegundos);

  if (delayMs > 0) {
    const delaySegundos = Math.ceil(delayMs / 1000);
    contadoresProxLectura.set(reg.id, delaySegundos);
    actualizarEstadoRegistrador(reg.id, 'activo', delaySegundos);
    log(`Polling para ${reg.nombre} iniciará en ${delaySegundos}s (escalonado por IP compartida)`, 'ciclo');

    setTimeout(() => {
      if (!cicloActivo) return;
      const regActual = registradoresCache.find(r => r.id === reg.id);
      if (regActual && regActual.activo) {
        leerRegistrador(regActual);
        contadoresProxLectura.set(reg.id, intervaloSegundos);
        actualizarEstadoRegistrador(reg.id, 'activo', intervaloSegundos);
      }
    }, delayMs);
  } else {
    contadoresProxLectura.set(reg.id, intervaloSegundos);
    actualizarEstadoRegistrador(reg.id, 'activo', intervaloSegundos);
    leerRegistrador(reg);
  }

  const intervalId = setInterval(() => {
    if (cicloActivo) {
      const regActual = registradoresCache.find(r => r.id === reg.id);
      if (regActual && regActual.activo) {
        leerRegistrador(regActual);
        const nuevoIntervalo = regActual.intervalo_segundos || 60;
        contadoresProxLectura.set(reg.id, nuevoIntervalo);
        actualizarEstadoRegistrador(reg.id, 'activo', nuevoIntervalo);
      }
    }
  }, intervaloMs);

  intervalosLectura.set(reg.id, intervalId);
  log(`Polling iniciado para ${reg.nombre} (cada ${intervaloSegundos}s)`, 'ciclo');
}

function detenerPollingRegistrador(regId) {
  const intervalId = intervalosLectura.get(regId);
  if (intervalId) {
    clearInterval(intervalId);
    intervalosLectura.delete(regId);
    contadoresProxLectura.delete(regId);
    log(`Polling detenido para registrador ${regId}`, 'advertencia');
  }
}

async function actualizarRegistradoresGranular(registradoresNuevos) {
  if (!registradoresNuevos) return;

  const nuevosTransformados = registradoresNuevos.map(r => ({
    id: r.id,
    nombre: r.nombre,
    tipo: r.tipo,
    ip: r.ip,
    puerto: r.puerto,
    unit_id: r.unitId,
    indice_inicial: r.indiceInicial,
    cantidad_registros: r.cantidadRegistros,
    intervalo_segundos: r.intervaloSegundos,
    timeout_ms: r.timeoutMs,
    activo: r.activo !== false,
    alimentador: r.alimentador,
    estado: r.activo !== false ? 'activo' : 'inactivo',
    proximaLectura: null,
  }));

  const idsNuevos = new Set(nuevosTransformados.map(r => r.id));
  const idsActuales = new Set(registradoresCache.map(r => r.id));

  for (const regActual of registradoresCache) {
    if (!idsNuevos.has(regActual.id)) {
      log(`Registrador eliminado: ${regActual.nombre}`, 'advertencia');
      detenerPollingRegistrador(regActual.id);
    }
  }

  for (const regNuevo of nuevosTransformados) {
    if (!idsActuales.has(regNuevo.id)) {
      log(`Nuevo registrador detectado: ${regNuevo.nombre}`, 'info');
      if (regNuevo.activo) {
        iniciarPollingRegistrador(regNuevo);
      }
    }
  }

  for (const regNuevo of nuevosTransformados) {
    const regActual = registradoresCache.find(r => r.id === regNuevo.id);
    if (regActual) {
      if (regActual.activo && !regNuevo.activo) {
        log(`Registrador desactivado: ${regNuevo.nombre}`, 'advertencia');
        detenerPollingRegistrador(regNuevo.id);
        actualizarEstadoRegistrador(regNuevo.id, 'inactivo');
      } else if (!regActual.activo && regNuevo.activo) {
        log(`Registrador activado: ${regNuevo.nombre}`, 'exito');
        iniciarPollingRegistrador(regNuevo);
      } else if (regActual.intervalo_segundos !== regNuevo.intervalo_segundos) {
        log(`Intervalo cambiado para ${regNuevo.nombre}: ${regActual.intervalo_segundos}s -> ${regNuevo.intervalo_segundos}s`, 'info');
      }
    }
  }

  registradoresCache = nuevosTransformados;
  notificarCambio('registradores', registradoresCache);
}

async function ejecutarTestConexion(test) {
  if (testsEnProceso.has(test.id)) {
    return;
  }

  testsEnProceso.add(test.id);

  log(`Ejecutando test: ${test.ip}:${test.puerto} (registros ${test.indice_inicial}-${test.indice_inicial + test.cantidad_registros - 1})`, 'ciclo');

  try {
    const resultado = await testConexionModbus({
      ip: test.ip,
      puerto: test.puerto,
      unitId: test.unit_id || 1,
      indiceInicial: test.indice_inicial,
      cantRegistros: test.cantidad_registros,
    });

    if (resultado.exito) {
      log(`Test exitoso: ${resultado.tiempoMs}ms - ${resultado.registros.length} registros`, 'exito');

      await restService.reportarResultadoTest(test.id, {
        exito: true,
        tiempoRespuestaMs: resultado.tiempoMs,
        valores: resultado.registros.map(r => r.valor),
      });
    } else {
      log(`Test fallido: ${resultado.error}`, 'error');

      await restService.reportarResultadoTest(test.id, {
        exito: false,
        tiempoRespuestaMs: resultado.tiempoMs,
        errorMensaje: resultado.error,
      });
    }
  } catch (error) {
    log(`Error ejecutando test: ${error.message}`, 'error');

    try {
      await restService.reportarResultadoTest(test.id, {
        exito: false,
        errorMensaje: error.message,
      });
    } catch (e) {
      log(`Error reportando resultado: ${e.message}`, 'error');
    }
  } finally {
    testsEnProceso.delete(test.id);
  }
}

function detenerPolling() {
  cicloActivo = false;

  intervalosLectura.forEach((intervalId) => {
    clearInterval(intervalId);
  });
  intervalosLectura.clear();
  contadoresProxLectura.clear();

  if (contadorIntervalId) {
    clearInterval(contadorIntervalId);
    contadorIntervalId = null;
  }

  log('Polling detenido', 'advertencia');
  notificarCambio('pollingActivo', false);
}

function obtenerRegistradores() {
  return registradoresCache;
}

function estaActivo() {
  return cicloActivo;
}

module.exports = {
  configurar,
  cargarRegistradores,
  iniciarPolling,
  detenerPolling,
  actualizarRegistradoresGranular,
  ejecutarTestConexion,
  obtenerRegistradores,
  estaActivo,
};
