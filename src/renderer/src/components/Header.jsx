function Header({ conectado, agente, workspace, pollingActivo, onRecargar, onTogglePolling, onCerrar }) {
  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">RelayWatch Agente</h1>

        <div className="header-info">
          <div className="header-item">
            <span className={`status-dot ${conectado ? 'connected' : 'disconnected'}`}></span>
            <span className="value">{conectado ? 'Conectado' : 'Desconectado'}</span>
          </div>

          {agente && (
            <div className="header-item">
              <span className="label">Agente:</span>
              <span className="value">{agente.nombre}</span>
            </div>
          )}

          {workspace && (
            <div className="header-item">
              <span className="label">Workspace:</span>
              <span className="value">{workspace.nombre}</span>
            </div>
          )}
        </div>
      </div>

      <div className="header-actions">
        <button className="btn btn-secondary" onClick={onRecargar}>
          Recargar
        </button>

        <button
          className={`btn ${pollingActivo ? 'btn-danger' : 'btn-primary'}`}
          onClick={onTogglePolling}
        >
          {pollingActivo ? 'Detener' : 'Iniciar'}
        </button>

        <button className="btn btn-danger" onClick={onCerrar} title="Cerrar agente">
          Cerrar
        </button>
      </div>
    </header>
  );
}

export default Header;
