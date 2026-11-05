/* La app se mudó a av-ahorros.pages.dev. Si este navegador tiene datos en la dirección
   anterior, permite descargarlos antes de seguir; si no, redirige de inmediato. */
(function () {
  'use strict';

  const DESTINO = 'https://av-ahorros.pages.dev/';
  let datos = null;
  try {
    datos = localStorage.getItem('alcancia.v1');
  } catch (e) {
    datos = null;
  }

  let respaldo = null;
  try {
    const estado = JSON.parse(datos);
    const tieneDatos = estado && [estado.goals, estado.moves, estado.txs]
      .some((lista) => Array.isArray(lista) && lista.length > 0);
    if (tieneDatos) respaldo = JSON.stringify(Object.assign({ app: 'alcancia' }, estado), null, 2);
  } catch (e) {
    respaldo = datos;
  }

  if (!respaldo) {
    location.replace(DESTINO);
    return;
  }

  document.getElementById('con-datos').hidden = false;
  document.getElementById('descargar').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([respaldo], { type: 'application/json' }));
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = 'av-ahorros-respaldo.json';
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
})();
