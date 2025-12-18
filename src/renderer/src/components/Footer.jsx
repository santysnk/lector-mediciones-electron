function Footer({ tiempoActivo, totalRegistradores, registradoresActivos }) {
  const formatTiempo = (segundos) => {
    const horas = Math.floor(segundos / 3600);
    const minutos = Math.floor((segundos % 3600) / 60);
    const segs = segundos % 60;

    return [
      horas.toString().padStart(2, '0'),
      minutos.toString().padStart(2, '0'),
      segs.toString().padStart(2, '0'),
    ].join(':');
  };

  return (
    <footer className="footer">
      <div className="footer-left">
        <span>Tiempo activo: {formatTiempo(tiempoActivo)}</span>
        <span>|</span>
        <span>Registradores: {registradoresActivos}/{totalRegistradores}</span>
      </div>

      <div className="footer-right">
        <span>RelayWatch Agente v1.0.0</span>
      </div>
    </footer>
  );
}

export default Footer;
