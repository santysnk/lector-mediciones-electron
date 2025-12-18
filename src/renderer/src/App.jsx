import { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import RegistradoresList from './components/RegistradoresList';
import LogsList from './components/LogsList';
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
        logs: [log, ...prev.logs].slice(0, 100),
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
        <RegistradoresList registradores={registradoresConContadores} />
        <LogsList logs={estado.logs} registradores={registradoresConContadores} />
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
