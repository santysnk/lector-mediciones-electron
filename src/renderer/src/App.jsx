import { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import RegistradoresList from './components/RegistradoresList';
import LogsList from './components/LogsList';
import LogsRegistradores from './components/LogsRegistradores';
import Footer from './components/Footer';

function App() {
  const [estado, setEstado] = useState({
    conectado: false,
    agente: null,
    workspace: null,
    registradores: [],
    logs: [],
    pollingActivo: false,
    tiempoActivo: 0,
  });

  const [contadores, setContadores] = useState({});

  // Estado para pestanas dinamicas de logs por registrador
  const [pestanasLogs, setPestanasLogs] = useState([]);
  const [tabActivaRegistrador, setTabActivaRegistrador] = useState(null);

  // Cargar estado inicial
  useEffect(() => {
    const cargarEstado = async () => {
      try {
        const estadoInicial = await window.electronAPI.getEstado();
        setEstado(estadoInicial);
      } catch (error) {
        console.error('Error cargando estado:', error);
      }
    };

    cargarEstado();

    // Actualizar tiempo activo cada segundo
    const intervalo = setInterval(async () => {
      try {
        const nuevoEstado = await window.electronAPI.getEstado();
        setEstado(prev => ({ ...prev, tiempoActivo: nuevoEstado.tiempoActivo }));
      } catch (error) {
        // Ignorar
      }
    }, 1000);

    return () => clearInterval(intervalo);
  }, []);

  // Suscribirse a eventos
  useEffect(() => {
    const cleanups = [];

    cleanups.push(window.electronAPI.onConectado((conectado) => {
      setEstado(prev => ({ ...prev, conectado }));
    }));

    cleanups.push(window.electronAPI.onAgente((agente) => {
      setEstado(prev => ({ ...prev, agente }));
    }));

    cleanups.push(window.electronAPI.onWorkspace((workspace) => {
      setEstado(prev => ({ ...prev, workspace }));
    }));

    cleanups.push(window.electronAPI.onRegistradores((registradores) => {
      setEstado(prev => ({ ...prev, registradores }));
    }));

    cleanups.push(window.electronAPI.onRegistradorActualizado((data) => {
      setEstado(prev => ({
        ...prev,
        registradores: prev.registradores.map(r =>
          r.id === data.id
            ? {
                ...r,
                estado: data.estado,
                proximaLectura: data.proximaLectura,
                lecturasExitosas: data.lecturasExitosas,
                lecturasFallidas: data.lecturasFallidas,
              }
            : r
        ),
      }));
    }));

    cleanups.push(window.electronAPI.onContadores((nuevosContadores) => {
      setContadores(nuevosContadores);
    }));

    cleanups.push(window.electronAPI.onLog((log) => {
      setEstado(prev => ({
        ...prev,
        logs: [log, ...prev.logs].slice(0, 500),
      }));
    }));

    cleanups.push(window.electronAPI.onPollingActivo((pollingActivo) => {
      setEstado(prev => ({ ...prev, pollingActivo }));
    }));

    return () => cleanups.forEach(cleanup => cleanup && cleanup());
  }, []);

  const handleRecargar = useCallback(async () => {
    await window.electronAPI.recargar();
  }, []);

  const handleTogglePolling = useCallback(async () => {
    if (estado.pollingActivo) {
      await window.electronAPI.detenerPolling();
    } else {
      await window.electronAPI.iniciarPolling();
    }
  }, [estado.pollingActivo]);

  // Combinar registradores con contadores
  const registradoresConContadores = estado.registradores.map(r => ({
    ...r,
    proximaLectura: contadores[r.id] ?? r.proximaLectura,
  }));

  // Abrir pestana de logs para un registrador
  const handleAbrirLogsRegistrador = useCallback((registrador) => {
    setPestanasLogs(prev => {
      // Si ya existe la pestana, solo activarla
      if (prev.some(p => p.id === registrador.id)) {
        setTabActivaRegistrador(registrador.id);
        return prev;
      }
      // Agregar nueva pestana
      const nuevasPestanas = [...prev, { id: registrador.id, nombre: registrador.nombre }];
      setTabActivaRegistrador(registrador.id);
      return nuevasPestanas;
    });
  }, []);

  // Cerrar pestana de logs
  const handleCerrarTabRegistrador = useCallback((id) => {
    setPestanasLogs(prev => {
      const nuevas = prev.filter(p => p.id !== id);
      // Si cerramos la tab activa, activar la anterior o ninguna
      if (tabActivaRegistrador === id) {
        const idx = prev.findIndex(p => p.id === id);
        if (nuevas.length > 0) {
          const nuevaActiva = nuevas[Math.max(0, idx - 1)]?.id || nuevas[0]?.id;
          setTabActivaRegistrador(nuevaActiva);
        } else {
          setTabActivaRegistrador(null);
        }
      }
      return nuevas;
    });
  }, [tabActivaRegistrador]);

  return (
    <div className="app-container">
      <Header
        conectado={estado.conectado}
        agente={estado.agente}
        workspace={estado.workspace}
        pollingActivo={estado.pollingActivo}
        onRecargar={handleRecargar}
        onTogglePolling={handleTogglePolling}
      />

      <div className="main-content">
        {/* Panel izquierdo: Registradores */}
        <div className="panel-izquierdo">
          <RegistradoresList
            registradores={registradoresConContadores}
            onAbrirLogs={handleAbrirLogsRegistrador}
          />
        </div>

        {/* Panel derecho: Logs */}
        <div className="panel-derecho">
          <LogsList logs={estado.logs} registradores={registradoresConContadores} />
          <LogsRegistradores
            logs={estado.logs}
            pestanasAbiertas={pestanasLogs}
            tabActiva={tabActivaRegistrador}
            onCambiarTab={setTabActivaRegistrador}
            onCerrarTab={handleCerrarTabRegistrador}
          />
        </div>
      </div>

      <Footer
        tiempoActivo={estado.tiempoActivo}
        totalRegistradores={estado.registradores.length}
        registradoresActivos={estado.registradores.filter(r => r.activo).length}
      />
    </div>
  );
}

export default App;
