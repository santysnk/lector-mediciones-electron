import { useState, useRef, useEffect } from 'react';

function RegistradoresList({ registradores, onAbrirLogs }) {
  const [menuContextual, setMenuContextual] = useState({ visible: false, x: 0, y: 0, registrador: null });
  const menuRef = useRef(null);

  const getEstadoIcon = (estado) => {
    switch (estado) {
      case 'activo':
        return String.fromCharCode(9679); // ●
      case 'error':
        return String.fromCharCode(10005); // ✕
      case 'inactivo':
        return String.fromCharCode(9675); // ○
      case 'leyendo':
        return String.fromCharCode(9680); // ◐
      default:
        return String.fromCharCode(9675); // ○
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

  // Calcular totales de lecturas
  const totalExitosas = registradores.reduce((sum, r) => sum + (r.lecturasExitosas || 0), 0);
  const totalFallidas = registradores.reduce((sum, r) => sum + (r.lecturasFallidas || 0), 0);

  // Manejar click derecho
  const handleContextMenu = (e, registrador) => {
    e.preventDefault();
    setMenuContextual({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      registrador
    });
  };

  // Cerrar menu al hacer click fuera
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuContextual(prev => ({ ...prev, visible: false }));
      }
    };

    if (menuContextual.visible) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [menuContextual.visible]);

  const handleVerLogs = () => {
    if (menuContextual.registrador && onAbrirLogs) {
      onAbrirLogs(menuContextual.registrador);
    }
    setMenuContextual(prev => ({ ...prev, visible: false }));
  };

  return (
    <section className="registradores-section">
      <div className="section-header">
        <span>Registradores ({activos} activos de {registradores.length})</span>
        <span className="lecturas-totales">
          <span className="lecturas-exitosas">OK: {totalExitosas}</span>
          <span className="lecturas-fallidas">ERR: {totalFallidas}</span>
        </span>
      </div>

      <div className="registradores-list">
        {registradores.length === 0 ? (
          <div className="empty-state">
            <p>No hay registradores configurados</p>
          </div>
        ) : (
          <>
            {/* Cabecera de la tabla */}
            <div className="registrador-row registrador-header">
              <div className="estado-icon"></div>
              <div className="registrador-nombre">Nombre</div>
              <div className="registrador-ip">IP:Puerto</div>
              <div className="registrador-registros">Registros</div>
              <div className="registrador-intervalo">Interv</div>
              <div className="registrador-countdown">Prox</div>
              <div className="registrador-lecturas">OK/ERR</div>
              <div>Estado</div>
            </div>

            {/* Filas de datos */}
            {registradores.map((reg) => (
              <div
                key={reg.id}
                className="registrador-row"
                onContextMenu={(e) => handleContextMenu(e, reg)}
              >
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

                <div className="registrador-lecturas">
                  <span className="lecturas-ok">{reg.lecturasExitosas || 0}</span>
                  <span className="lecturas-sep">/</span>
                  <span className="lecturas-err">{reg.lecturasFallidas || 0}</span>
                </div>

                <div>
                  <span className={`badge ${reg.estado || 'inactivo'}`}>
                    {reg.estado || 'inactivo'}
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Menu contextual */}
      {menuContextual.visible && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: menuContextual.y, left: menuContextual.x }}
        >
          <button className="context-menu-item" onClick={handleVerLogs}>
            Ver logs
          </button>
        </div>
      )}
    </section>
  );
}

export default RegistradoresList;
