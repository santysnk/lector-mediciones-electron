function RegistradoresList({ registradores }) {
  const getEstadoIcon = (estado) => {
    switch (estado) {
      case 'activo':
        return '●';
      case 'error':
        return '✕';
      case 'inactivo':
        return '○';
      case 'leyendo':
        return '◐';
      default:
        return '○';
    }
  };

  const formatCountdown = (segundos) => {
    if (segundos === null || segundos === undefined) return '--';
    if (segundos <= 0) return '0s';
    if (segundos < 60) return `${segundos}s`;
    const mins = Math.floor(segundos / 60);
    const secs = segundos % 60;
    return `${mins}m ${secs}s`;
  };

  const activos = registradores.filter(r => r.activo).length;

  return (
    <section className="registradores-section">
      <div className="section-header">
        <span>Registradores ({activos} activos de {registradores.length})</span>
      </div>

      <div className="registradores-list">
        {registradores.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p>No hay registradores configurados</p>
          </div>
        ) : (
          registradores.map((reg) => (
            <div key={reg.id} className="registrador-row">
              <div className={`estado-icon ${reg.estado || 'inactivo'}`}>
                {getEstadoIcon(reg.estado)}
              </div>

              <div className="registrador-nombre">{reg.nombre}</div>

              <div className="registrador-ip">
                {reg.ip}:{reg.puerto}
              </div>

              <div className="registrador-registros">
                [{reg.indice_inicial}-{reg.indice_inicial + reg.cantidad_registros - 1}]
              </div>

              <div className="registrador-intervalo">
                {reg.intervalo_segundos}s
              </div>

              <div className={`registrador-countdown ${reg.proximaLectura <= 5 ? 'warning' : 'normal'}`}>
                {reg.activo ? formatCountdown(reg.proximaLectura) : '--'}
              </div>

              <div>
                <span className={`badge ${reg.estado || 'inactivo'}`}>
                  {reg.estado || 'inactivo'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default RegistradoresList;
