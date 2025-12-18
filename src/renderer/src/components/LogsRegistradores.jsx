import { useRef, useMemo } from 'react';

function LogsRegistradores({ logs, pestanasAbiertas, tabActiva, onCambiarTab, onCerrarTab }) {
  const listRef = useRef(null);

  const getLogIcon = (tipo) => {
    switch (tipo) {
      case 'exito':
        return '+';
      case 'error':
        return '!';
      case 'advertencia':
        return '!';
      case 'ciclo':
        return '>';
      default:
        return '-';
    }
  };

  // Filtrar logs según la pestaña activa
  const logsFiltrados = useMemo(() => {
    if (!tabActiva) return [];
    const pestana = pestanasAbiertas.find(p => p.id === tabActiva);
    if (!pestana) return [];

    return logs.filter(log =>
      log.registradorId === pestana.id ||
      (log.mensaje && log.mensaje.includes(pestana.nombre))
    );
  }, [logs, tabActiva, pestanasAbiertas]);

  if (pestanasAbiertas.length === 0) {
    return (
      <section className="logs-registradores-section">
        <div className="section-header">
          <span>Logs por Registrador</span>
        </div>
        <div className="logs-empty-hint">
          <p>Click derecho en un registrador para ver sus logs</p>
        </div>
      </section>
    );
  }

  return (
    <section className="logs-registradores-section">
      <div className="section-header">
        <span>Logs ({logsFiltrados.length})</span>
      </div>

      <div className="logs-tabs">
        {pestanasAbiertas.map(tab => (
          <button
            key={tab.id}
            className={`log-tab ${tabActiva === tab.id ? 'active' : ''}`}
            onClick={() => onCambiarTab(tab.id)}
            title={tab.nombre}
          >
            <span className="tab-nombre">{tab.nombre.length > 12 ? tab.nombre.substring(0, 12) + '...' : tab.nombre}</span>
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onCerrarTab(tab.id);
              }}
            >
              x
            </span>
          </button>
        ))}
      </div>

      <div className="logs-list" ref={listRef}>
        {logsFiltrados.length === 0 ? (
          <div className="empty-state">
            <p>Sin logs para este registrador...</p>
          </div>
        ) : (
          logsFiltrados.map((log, index) => (
            <div key={index} className="log-entry">
              <span className="log-timestamp">{log.timestamp}</span>
              <span className={`log-icon ${log.tipo}`}>{getLogIcon(log.tipo)}</span>
              <span className="log-message">{log.mensaje}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default LogsRegistradores;
