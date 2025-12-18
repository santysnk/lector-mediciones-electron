// src/main/modbus/clienteModbus.js
// Cliente Modbus para leer registros de dispositivos

const ModbusRTU = require('modbus-serial');

/**
 * Lee registros holding de un dispositivo Modbus TCP
 */
async function leerRegistrosModbus({ ip, puerto, indiceInicial, cantRegistros, unitId = 1 }) {
  const inicio = Number(indiceInicial);
  const cantidad = Number(cantRegistros);
  const puertoNum = Number(puerto);

  if (!ip || !puertoNum || Number.isNaN(inicio) || Number.isNaN(cantidad) || cantidad <= 0) {
    console.warn(`[Modbus] Parámetros inválidos: ip=${ip}, puerto=${puertoNum}, inicio=${inicio}, cantidad=${cantidad}`);
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
    try {
      cliente.close();
    } catch (e) {
      // Ignorar errores al cerrar
    }
  }
}

/**
 * Prueba la conexión a un dispositivo Modbus TCP y lee registros
 */
async function testConexionModbus({ ip, puerto, unitId = 1, indiceInicial = 0, cantRegistros = 10 }) {
  const puertoNum = Number(puerto);
  const inicio = Number(indiceInicial) || 0;
  const cantidad = Number(cantRegistros) || 10;

  if (!ip || !puertoNum) {
    return {
      exito: false,
      error: 'IP y puerto son requeridos',
    };
  }

  const cliente = new ModbusRTU();
  const tiempoInicio = Date.now();

  try {
    await cliente.connectTCP(ip, { port: puertoNum });
    cliente.setID(unitId);
    cliente.setTimeout(5000);

    const respuesta = await cliente.readHoldingRegisters(inicio, cantidad);
    const tiempoMs = Date.now() - tiempoInicio;

    const registros = respuesta.data.map((valor, i) => ({
      indice: i,
      direccion: inicio + i,
      valor: valor,
    }));

    return {
      exito: true,
      tiempoMs,
      mensaje: `Conexión exitosa en ${tiempoMs}ms`,
      registros,
    };
  } catch (error) {
    const tiempoMs = Date.now() - tiempoInicio;

    return {
      exito: false,
      error: error.message || 'Error de conexión desconocido',
      tiempoMs,
    };
  } finally {
    try {
      cliente.close();
    } catch (e) {
      // Ignorar errores al cerrar
    }
  }
}

module.exports = { leerRegistrosModbus, testConexionModbus };
