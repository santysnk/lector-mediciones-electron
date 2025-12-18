import { useRef, useState, useMemo } from 'react';

function LogsList({ logs, registradores = [] }) {
  const listRef = useRef(null);
  const [tabActiva, setTabActiva] = useState('todos');

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

  // Agrupar logs por registrador
  const logsPorRegistrador = useMemo(() => {
    const grupos = { todos: logs };

    // Crear grupos para cada registrador
    registradores.forEach(reg => {
      grupos[reg.id] = logs.filter(log =>
        log.registradorId === reg.id ||
        (log.mensaje && log.mensaje.includes(reg.nombre))
      );
    });

    // Logs del sistema (no asociados a registradores específicos)
    grupos['sistema'] = logs.filter(log =>
      !log.registradorId &&
      !registradores.some(reg => log.mensaje && log.mensaje.includes(reg.nombre))
    );

    return grupos;
  }, [logs, registradores]);

  // Obtener logs filtrados según la pestaña activa
  const logsFiltrados = logsPorRegistrador[tabActiva] || [];

  // Generar pestañas dinámicamente
  const tabs = useMemo(() => {
    const pestanas = [
      { id: 'todos', nombre: 'Todos', count: logs.length }
    ];

    registradores.forEach(reg => {
      const logsDelRegistrador = logsPorRegistrador[reg.id] || [];
      if (logsDelRegistrador.length > 0 || reg.activo) {
        pestanas.push({
          id: reg.id,
          nombre: reg.nombre.length > 12 ? reg.nombre.substring(0, 12) + '...' : reg.nombre,
          nombreCompleto: reg.nombre,
          count: logsDelRegistrador.length
        });
      }
    });

    if (logsPorRegistrador['sistema']?.length > 0) {
      pestanas.push({
        id: 'sistema',
        nombre: 'Sistema',
        count: logsPorRegistrador['sistema'].length
      });
    }

    return pestanas;
  }, [logs, registradores, logsPorRegistrador]);

  return (
    <section className="logs-section">
      <div className="section-header">
        <span>Logs ({logsFiltrados.length})</span>
      </div>

      {/* Pestañas de filtrado */}
      <div className="logs-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`log-tab ${tabActiva === tab.id ? 'active' : ''}`}
            onClick={() => setTabActiva(tab.id)}
            title={tab.nombreCompleto || tab.nombre}
          >
            {tab.nombre}
            <span className="tab-count">{tab.count}</span>
          </button>
        ))}
      </div>

      <div className="logs-list" ref={listRef}>
        {logsFiltrados.length === 0 ? (
          <div className="empty-state">
            <p>Sin logs todavia...</p>
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

export default LogsList;
