import { useState, useEffect, useCallback, useRef } from 'react';
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

  // Estado para tamanos de paneles (en porcentaje)
  const [anchoIzquierdo, setAnchoIzquierdo] = useState(55);
  const [altoLogsSistema, setAltoLogsSistema] = useState(50);

  // Estado para tamano de fuente de logs (independiente para cada contenedor)
  const [fontSizeSistema, setFontSizeSistema] = useState(11);
  const [fontSizeRegistrador, setFontSizeRegistrador] = useState(11);

  // Refs para el resize
  const mainContentRef = useRef(null);
  const panelDerechoRef = useRef(null);
  const resizingRef = useRef(null);

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

  // Manejadores de resize
  const handleMouseDown = useCallback((tipo) => (e) => {
    e.preventDefault();
    resizingRef.current = tipo;
    document.body.style.cursor = tipo === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!resizingRef.current) return;

      if (resizingRef.current === 'horizontal' && mainContentRef.current) {
        const rect = mainContentRef.current.getBoundingClientRect();
        const nuevoAncho = ((e.clientX - rect.left) / rect.width) * 100;
        setAnchoIzquierdo(Math.max(25, Math.min(75, nuevoAncho)));
      }

      if (resizingRef.current === 'vertical' && panelDerechoRef.current) {
        const rect = panelDerechoRef.current.getBoundingClientRect();
        const nuevoAlto = ((e.clientY - rect.top) / rect.height) * 100;
        setAltoLogsSistema(Math.max(20, Math.min(80, nuevoAlto)));
      }
    };

    const handleMouseUp = () => {
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
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
      if (prev.some(p => p.id === registrador.id)) {
        setTabActivaRegistrador(registrador.id);
        return prev;
      }
      const nuevasPestanas = [...prev, { id: registrador.id, nombre: registrador.nombre }];
      setTabActivaRegistrador(registrador.id);
      return nuevasPestanas;
    });
  }, []);

  // Cerrar pestana de logs
  const handleCerrarTabRegistrador = useCallback((id) => {
    setPestanasLogs(prev => {
      const nuevas = prev.filter(p => p.id !== id);
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

  // Handlers para zoom de fuente - Contenedor Sistema
  const handleZoomInSistema = useCallback(() => {
    setFontSizeSistema(prev => Math.min(18, prev + 1));
  }, []);

  const handleZoomOutSistema = useCallback(() => {
    setFontSizeSistema(prev => Math.max(8, prev - 1));
  }, []);

  // Handlers para zoom de fuente - Contenedor Registrador
  const handleZoomInRegistrador = useCallback(() => {
    setFontSizeRegistrador(prev => Math.min(18, prev + 1));
  }, []);

  const handleZoomOutRegistrador = useCallback(() => {
    setFontSizeRegistrador(prev => Math.max(8, prev - 1));
  }, []);

  // Handler para cerrar la aplicacion
  const handleCerrarAgente = useCallback(() => {
    window.electronAPI.cerrarAgente();
  }, []);

  return (
    <div className="app-container">
      <Header
        conectado={estado.conectado}
        agente={estado.agente}
        workspace={estado.workspace}
        pollingActivo={estado.pollingActivo}
        onRecargar={handleRecargar}
        onTogglePolling={handleTogglePolling}
        onCerrar={handleCerrarAgente}
      />

      <div className="main-content" ref={mainContentRef}>
        {/* Panel izquierdo: Registradores */}
        <div className="panel-izquierdo" style={{ width: `${anchoIzquierdo}%` }}>
          <RegistradoresList
            registradores={registradoresConContadores}
            onAbrirLogs={handleAbrirLogsRegistrador}
          />
        </div>

        {/* Resizer horizontal */}
        <div
          className="resizer resizer-horizontal"
          onMouseDown={handleMouseDown('horizontal')}
        />

        {/* Panel derecho: Logs */}
        <div
          className="panel-derecho"
          ref={panelDerechoRef}
          style={{ width: `${100 - anchoIzquierdo}%` }}
        >
          <div style={{ height: `${altoLogsSistema}%`, display: 'flex', flexDirection: 'column' }}>
            <LogsList
              logs={estado.logs}
              registradores={registradoresConContadores}
              fontSize={fontSizeSistema}
              onZoomIn={handleZoomInSistema}
              onZoomOut={handleZoomOutSistema}
            />
          </div>

          {/* Resizer vertical */}
          <div
            className="resizer resizer-vertical"
            onMouseDown={handleMouseDown('vertical')}
          />

          <div style={{ height: `${100 - altoLogsSistema}%`, display: 'flex', flexDirection: 'column' }}>
            <LogsRegistradores
              logs={estado.logs}
              pestanasAbiertas={pestanasLogs}
              tabActiva={tabActivaRegistrador}
              onCambiarTab={setTabActivaRegistrador}
              onCerrarTab={handleCerrarTabRegistrador}
              fontSize={fontSizeRegistrador}
              onZoomIn={handleZoomInRegistrador}
              onZoomOut={handleZoomOutRegistrador}
            />
          </div>
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
