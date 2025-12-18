import { useRef, useEffect } from 'react';

function LogsList({ logs }) {
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

  return (
    <section className="logs-section">
      <div className="section-header">
        <span>Logs ({logs.length})</span>
      </div>

      <div className="logs-list" ref={listRef}>
        {logs.length === 0 ? (
          <div className="empty-state">
            <p>Sin logs todavia...</p>
          </div>
        ) : (
          logs.map((log, index) => (
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
