import { useRef, useState, useMemo } from 'react';

function LogsList({ logs, registradores = [], fontSize = 11, onZoomIn, onZoomOut }) {
  const listRef = useRef(null);
  const [tabActiva, setTabActiva] = useState('sistema');

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

  // Separar logs de sistema de los de registradores
  const { logsSistema, logsTodos } = useMemo(() => {
    const sistema = logs.filter(log =>
      !log.registradorId &&
      !registradores.some(reg => log.mensaje && log.mensaje.includes(reg.nombre))
    );
    return { logsSistema: sistema, logsTodos: logs };
  }, [logs, registradores]);

  const logsFiltrados = tabActiva === 'sistema' ? logsSistema : logsTodos;

  return (
    <section className="logs-section logs-sistema">
      <div className="section-header">
        <span>Logs ({logsFiltrados.length})</span>
        <div className="zoom-controls">
          <button className="btn-zoom" onClick={onZoomOut} title="Reducir fuente">-</button>
          <span className="zoom-size">{fontSize}px</span>
          <button className="btn-zoom" onClick={onZoomIn} title="Aumentar fuente">+</button>
        </div>
      </div>

      <div className="logs-tabs">
        <button
          className={`log-tab ${tabActiva === 'sistema' ? 'active' : ''}`}
          onClick={() => setTabActiva('sistema')}
        >
          Sistema
          <span className="tab-count">{logsSistema.length}</span>
        </button>
        <button
          className={`log-tab ${tabActiva === 'todos' ? 'active' : ''}`}
          onClick={() => setTabActiva('todos')}
        >
          Todos
          <span className="tab-count">{logsTodos.length}</span>
        </button>
      </div>

      <div className="logs-list" ref={listRef} style={{ fontSize: `${fontSize}px` }}>
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
