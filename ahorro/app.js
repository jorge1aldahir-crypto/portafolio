/* Interfaz de AV ahorros. Todo texto del usuario pasa por esc() antes de llegar al HTML. */
(function () {
  'use strict';

  const C = window.AlcanciaCore;
  const KEY = 'alcancia.v1';
  const VERSION = '1.2.1';
  const INSTALL_HIDDEN_KEY = 'avahorros.instalar.oculto';
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const BACKUP_AFTER_DAYS = 30;
  const BACKUP_AFTER_RECORDS = 5;

  const main = document.getElementById('main');
  const nav = document.getElementById('nav');
  const sheet = document.getElementById('sheet');
  const confirmDlg = document.getElementById('confirm');
  const toastEl = document.getElementById('toast');

  const lang = (navigator.language || '').toLowerCase().startsWith('es') ? navigator.language : 'es-MX';
  const REGION_CURRENCY = {
    MX: 'MXN', US: 'USD', ES: 'EUR', AR: 'ARS', BO: 'BOB', CL: 'CLP', CO: 'COP', CR: 'CRC',
    DO: 'DOP', GT: 'GTQ', HN: 'HNL', PE: 'PEN', PY: 'PYG', UY: 'UYU', EC: 'USD', SV: 'USD', PA: 'USD',
  };

  let state = null;
  let fatalRaw = null;
  let viewMonth = C.todayISO().slice(0, 7);
  let onboardStep = 1;
  let installPrompt = null;
  let justInstalled = false;
  let lastRoute = null;
  let toastTimer = 0;

  /* ---------- Datos ---------- */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      return { unavailable: true };
    }
    if (!raw) {
      const fresh = C.emptyState();
      const region = (navigator.language || '').split('-')[1];
      fresh.currency = REGION_CURRENCY[(region || '').toUpperCase()] || 'MXN';
      return { state: fresh };
    }
    try {
      const parsed = JSON.parse(raw);
      const clean = C.sanitizeBackup(Object.assign({}, parsed, { app: 'alcancia' }));
      clean.onboarded = parsed.onboarded === true;
      return { state: clean };
    } catch (e) {
      return { corrupt: raw };
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast('No se pudo guardar. Revisa el espacio disponible en tu dispositivo.');
      return false;
    }
  }

  /* ---------- Formato ---------- */

  function money(cents) {
    return new Intl.NumberFormat(lang, { style: 'currency', currency: state.currency, currencyDisplay: 'narrowSymbol' }).format(cents / 100);
  }

  function isoToDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDate(iso) {
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(isoToDate(iso));
  }

  function monthName(month) {
    return new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(isoToDate(month + '-01'));
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /* ---------- Piezas de interfaz ---------- */

  function bar(pct, label, kind) {
    const value = Math.max(0, Math.min(100, pct));
    return '<div class="bar' + (kind ? ' ' + kind : '') + '" role="progressbar" aria-label="' + esc(label)
      + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + value + '"><i data-pct="' + value + '"></i></div>';
  }

  function goalPct(balance, target) {
    return Math.floor((balance / target) * 100);
  }

  function deadlineText(goal, balance) {
    if (balance >= goal.target) return '<span class="done">¡Meta alcanzada!</span>';
    if (!goal.deadline) return 'Sin fecha límite';
    const days = C.daysBetween(C.todayISO(), goal.deadline);
    if (days < 0) return '<span class="over">Venció el ' + esc(formatDate(goal.deadline)) + '</span>';
    if (days === 0) return 'Vence hoy';
    return 'Faltan ' + plural(days, 'día', 'días');
  }

  function goalCard(goal) {
    const balance = C.goalBalance(state, goal.id);
    const pct = goalPct(balance, goal.target);
    const reached = balance >= goal.target;
    return '<a class="card" href="#meta/' + esc(goal.id) + '">'
      + '<div class="card-top"><span class="card-title">' + esc(goal.name) + '</span><span class="pct">' + pct + '%</span></div>'
      + bar(pct, 'Progreso de ' + goal.name, reached ? 'is-done' : '')
      + '<div class="card-meta"><span class="money">' + money(balance) + ' de ' + money(goal.target) + '</span>'
      + '<span>' + deadlineText(goal, balance) + '</span></div></a>';
  }

  function needsBackup() {
    const records = state.moves.length + state.txs.length + state.goals.length;
    if (records < BACKUP_AFTER_RECORDS) return false;
    return !state.lastBackup || C.daysBetween(state.lastBackup, C.todayISO()) >= BACKUP_AFTER_DAYS;
  }

  function txRow(tx) {
    const cat = state.categories.find((c) => c.id === tx.categoryId);
    const title = tx.type === 'income' ? 'Ingreso' : (cat ? cat.name : 'Sin categoría');
    const sub = [formatDate(tx.date), tx.note].filter(Boolean).join(' · ');
    return '<li><button class="row" type="button" data-action="edit-tx" data-id="' + esc(tx.id) + '">'
      + '<span class="row-main"><span class="row-title">' + esc(title) + '</span><span class="row-sub">' + esc(sub) + '</span></span>'
      + '<span class="row-amount' + (tx.type === 'income' ? ' plus' : '') + '">' + (tx.type === 'income' ? '+' : '−') + money(tx.amount) + '</span></button></li>';
  }

  /* ---------- Pantallas ---------- */

  function viewInicio() {
    const month = C.todayISO().slice(0, 7);
    const s = C.monthSummary(state, month);
    const active = state.goals.filter((g) => C.goalBalance(state, g.id) < g.target);
    let hint;
    if (!s.income && !s.expense && !s.saved) hint = 'Registra tu primer ingreso para saber cuánto puedes ahorrar.';
    else if (s.available < 0) hint = 'Este mes has usado más de lo que ingresó.';
    else hint = 'Lo que te queda después de gastos y aportes.';

    return '<h1 class="page-title">Inicio</h1>'
      + '<section class="hero" aria-label="Resumen del mes"><span class="label">Disponible en ' + esc(monthName(month)) + '</span>'
      + '<span class="figure money">' + money(s.available) + '</span><span class="hint">' + hint + '</span>'
      + '<dl class="equation money"><div><dt>Ingresos</dt><dd>' + money(s.income) + '</dd></div>'
      + '<div><dt>Gastos</dt><dd>' + money(s.expense) + '</dd></div>'
      + '<div><dt>A metas</dt><dd>' + money(s.saved) + '</dd></div></dl></section>'
      + '<div class="btn-row"><button class="btn primary" type="button" data-action="new-tx" data-type="expense">Añadir gasto</button>'
      + '<button class="btn" type="button" data-action="new-tx" data-type="income">Añadir ingreso</button></div>'
      + (needsBackup()
        ? '<div class="notice"><p><strong>Guarda un respaldo.</strong> Tus datos solo están en este dispositivo; si se borran, no se pueden recuperar.</p>'
          + '<button class="btn" type="button" data-action="export">Guardar respaldo</button></div>'
        : '')
      + '<div data-install="inicio"></div>'
      + '<section class="section"><div class="section-head"><h2>Tus metas</h2><a class="btn link" href="#metas">Ver todas</a></div>'
      + (active.length
        ? '<div class="stack">' + active.slice(0, 3).map(goalCard).join('') + '</div>'
        : '<div class="empty"><p>' + (state.goals.length ? 'Alcanzaste todas tus metas. ¿Cuál sigue?' : 'Todavía no tienes metas. ¿Para qué quieres ahorrar?') + '</p>'
          + '<button class="btn primary" type="button" data-action="new-goal">Crear una meta</button></div>')
      + '</section>';
  }

  function viewMetas() {
    const withBalance = state.goals.map((g) => ({ g, reached: C.goalBalance(state, g.id) >= g.target }));
    const active = withBalance.filter((x) => !x.reached).map((x) => x.g);
    const reached = withBalance.filter((x) => x.reached).map((x) => x.g);
    return '<div class="head-row"><h1 class="page-title">Metas</h1><button class="btn primary" type="button" data-action="new-goal">Nueva meta</button></div>'
      + (state.goals.length
        ? '<p class="muted">Llevas <strong class="money">' + money(C.totalSaved(state)) + '</strong> ahorrados en total.</p>'
        : '<div class="empty"><p>Crea tu primera meta: un viaje, un fondo de emergencia o lo que tengas en mente.</p></div>')
      + (active.length ? '<div class="stack">' + active.map(goalCard).join('') + '</div>' : '')
      + (reached.length ? '<section class="section"><h2 class="section-title">Alcanzadas</h2><div class="stack">' + reached.map(goalCard).join('') + '</div></section>' : '');
  }

  function viewMeta(id) {
    const goal = state.goals.find((g) => g.id === id);
    if (!goal) return null;
    const balance = C.goalBalance(state, id);
    const reached = balance >= goal.target;
    const remaining = Math.max(0, goal.target - balance);
    const moves = state.moves.filter((m) => m.goalId === id).sort(C.byDateDesc);
    return '<a class="back" href="#metas">‹ Metas</a>'
      + '<div class="head-row"><h1 class="page-title">' + esc(goal.name) + '</h1>'
      + '<button class="btn" type="button" data-action="edit-goal" data-id="' + esc(id) + '">Editar</button></div>'
      + '<section class="card"><div class="goal-figure money">' + money(balance) + '</div>'
      + '<p class="muted money">de ' + money(goal.target) + (reached ? '' : ' · faltan ' + money(remaining)) + '</p>'
      + bar(goalPct(balance, goal.target), 'Progreso de ' + goal.name, reached ? 'is-done' : '')
      + '<div class="card-meta"><span>' + goalPct(balance, goal.target) + '%</span><span>' + deadlineText(goal, balance) + '</span></div></section>'
      + '<div class="btn-row"><button class="btn primary" type="button" data-action="new-move" data-id="' + esc(id) + '" data-type="in">Aportar</button>'
      + '<button class="btn" type="button" data-action="new-move" data-id="' + esc(id) + '" data-type="out"' + (balance > 0 ? '' : ' disabled') + '>Retirar</button></div>'
      + '<section class="section"><h2 class="section-title">Historial</h2>'
      + (moves.length
        ? '<ul class="rows">' + moves.map((m) => {
          const sub = [formatDate(m.date), m.note].filter(Boolean).join(' · ');
          return '<li><button class="row" type="button" data-action="edit-move" data-id="' + esc(m.id) + '">'
            + '<span class="row-main"><span class="row-title">' + (m.type === 'in' ? 'Aporte' : 'Retiro') + '</span><span class="row-sub">' + esc(sub) + '</span></span>'
            + '<span class="row-amount' + (m.type === 'in' ? ' plus' : '') + '">' + (m.type === 'in' ? '+' : '−') + money(m.amount) + '</span></button></li>';
        }).join('') + '</ul>'
        : '<div class="empty"><p>Aún no hay aportes. El primero, aunque sea pequeño, ya cuenta.</p></div>')
      + '</section>';
  }

  function categoryCard(cat, spent) {
    const budget = cat.budget;
    const over = budget > 0 && spent > budget;
    let meta;
    if (!budget) meta = '<span>Sin límite</span>';
    else if (over) meta = '<span class="over">Te pasaste por ' + money(spent - budget) + '</span>';
    else meta = '<span>Quedan ' + money(budget - spent) + '</span>';
    const body = '<div class="card-top"><span class="card-title">' + esc(cat.name) + '</span>'
      + '<span class="pct money">' + money(spent) + (budget ? ' / ' + money(budget) : '') + '</span></div>'
      + (budget ? bar(Math.floor((spent / budget) * 100), 'Gasto en ' + cat.name, over ? 'is-over' : '') : '')
      + '<div class="card-meta">' + meta + '</div>';
    return '<button class="card row-card" type="button" data-action="edit-category" data-id="' + esc(cat.id) + '">' + body + '</button>';
  }

  function viewPresupuesto() {
    const s = C.monthSummary(state, viewMonth);
    const txs = state.txs.filter((t) => t.date.slice(0, 7) === viewMonth).sort(C.byDateDesc);
    const totalBudget = state.categories.reduce((sum, c) => sum + c.budget, 0);
    const uncategorized = C.categorySpend(state, viewMonth, null);
    return '<div class="head-row"><h1 class="page-title">Presupuesto</h1><button class="btn primary" type="button" data-action="new-tx" data-type="expense">Añadir</button></div>'
      + '<div class="month"><button class="btn icon-btn" type="button" data-action="month" data-delta="-1" aria-label="Mes anterior">‹</button>'
      + '<strong aria-live="polite">' + esc(monthName(viewMonth)) + '</strong>'
      + '<button class="btn icon-btn" type="button" data-action="month" data-delta="1" aria-label="Mes siguiente">›</button></div>'
      + '<section class="hero" aria-label="Resumen del mes"><span class="label">Disponible</span><span class="figure money">' + money(s.available) + '</span>'
      + '<dl class="equation money"><div><dt>Ingresos</dt><dd>' + money(s.income) + '</dd></div>'
      + '<div><dt>Gastos</dt><dd>' + money(s.expense) + '</dd></div>'
      + '<div><dt>A metas</dt><dd>' + money(s.saved) + '</dd></div></dl></section>'
      + '<section class="section"><div class="section-head"><h2>Categorías</h2><button class="btn link" type="button" data-action="new-category">Nueva categoría</button></div>'
      + (totalBudget ? '<p class="muted small money">Presupuesto del mes: ' + money(totalBudget) + '</p>' : '<p class="muted small">Toca una categoría para ponerle un límite mensual.</p>')
      + '<div class="stack">' + state.categories.map((c) => categoryCard(c, C.categorySpend(state, viewMonth, c.id))).join('')
      + (uncategorized ? '<div class="card"><div class="card-top"><span class="card-title">Sin categoría</span><span class="pct money">' + money(uncategorized) + '</span></div></div>' : '')
      + '</div></section>'
      + '<section class="section"><h2 class="section-title">Movimientos</h2>'
      + (txs.length ? '<ul class="rows">' + txs.map(txRow).join('') + '</ul>' : '<div class="empty"><p>No hay ingresos ni gastos en este mes.</p></div>')
      + '</section>';
  }

  function viewAjustes() {
    return '<h1 class="page-title">Ajustes</h1>'
      + '<section class="card setting"><h2><label for="set-currency">Moneda</label></h2>'
      + '<select class="input" id="set-currency">' + currencyOptions(state.currency) + '</select>'
      + '<p class="muted small">Cambiarla no convierte tus montos; solo cambia cómo se muestran.</p></section>'
      + '<section class="card setting"><h2>Respaldo</h2>'
      + '<p class="muted small">Tus datos solo están en este dispositivo. Guarda un respaldo para no perderlos o para pasarlos a otro. '
      + (state.lastBackup ? 'Último respaldo: ' + esc(formatDate(state.lastBackup)) + '.' : 'Aún no has guardado ninguno.') + '</p>'
      + '<div class="btn-row"><button class="btn" type="button" data-action="export">Guardar respaldo</button>'
      + '<button class="btn" type="button" data-action="import">Restaurar respaldo</button></div>'
      + '<input id="import-file" type="file" accept="application/json,.json" hidden aria-label="Archivo de respaldo"></section>'
      + '<div data-install="ajustes"></div>'
      + '<section class="card setting"><h2>Privacidad</h2><p class="muted small">Sin cuentas ni seguimiento: AV ahorros no envía tus datos a ningún servidor.</p>'
      + '<a class="btn" href="privacidad.html">Leer el aviso de privacidad</a></section>'
      + '<section class="card setting"><h2>Borrar datos</h2><p class="muted small">Elimina todas tus metas, movimientos y categorías de este dispositivo.</p>'
      + '<button class="btn danger" type="button" data-action="erase">Borrar todo</button></section>'
      + '<p class="muted small">AV ahorros ' + VERSION + '</p>';
  }

  /* ---------- Instalación ---------- */

  function installMode() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (standalone || justInstalled) return null;
    if (installPrompt) return 'prompt';
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    return isIOS ? 'ios' : 'manual';
  }

  function installHidden() {
    try {
      return localStorage.getItem(INSTALL_HIDDEN_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  const IOS_STEPS = 'Toca el botón Compartir del navegador y luego “Agregar a inicio”.';
  const INSTALL_BUTTON = '<button class="btn primary" type="button" data-action="install">Instalar AV ahorros</button>';

  function installHtml(slot, mode) {
    if (!mode) return '';
    if (slot === 'ajustes') {
      let body = INSTALL_BUTTON;
      if (mode === 'ios') body = '<p class="muted small">' + IOS_STEPS + '</p>';
      if (mode === 'manual') body = '<p class="muted small">Si tu navegador lo permite, busca “Instalar” o “Agregar a la pantalla de inicio” en su menú.</p>';
      return '<section class="card setting"><h2>Instalar la app</h2>' + body + '</section>';
    }
    if (mode === 'manual') return '';
    if (slot === 'inicio' && installHidden()) return '';
    const text = mode === 'ios'
      ? '<strong>Instala AV ahorros.</strong> ' + IOS_STEPS
      : '<strong>Instala AV ahorros.</strong> Ábrela desde tu pantalla de inicio, incluso sin internet.';
    const later = slot === 'inicio' ? '<button class="btn" type="button" data-action="install-hide">Ahora no</button>' : '';
    const actions = (mode === 'prompt' ? INSTALL_BUTTON : '') + later;
    return '<div class="notice"><p>' + text + '</p>' + (actions ? '<div class="notice-actions">' + actions + '</div>' : '') + '</div>';
  }

  /* Actualiza solo estos espacios: volver a dibujar la pantalla borraría lo que se esté escribiendo. */
  function fillInstallSlots() {
    const mode = installMode();
    main.querySelectorAll('[data-install]').forEach((slot) => {
      slot.innerHTML = installHtml(slot.dataset.install, mode);
    });
  }

  function currencyOptions(selected) {
    return C.CURRENCIES.map(([code, name]) => (
      '<option value="' + code + '"' + (code === selected ? ' selected' : '') + '>' + esc(name) + ' (' + code + ')</option>'
    )).join('');
  }

  function viewWelcome() {
    if (onboardStep === 1) {
      return '<div class="welcome"><img class="mark" src="icons/icon-192.png" alt="" width="64" height="64">'
        + '<h1>Ahorra para lo que de verdad quieres.</h1>'
        + '<ul class="points"><li><strong>Metas claras</strong>Registra aportes y mira cuánto te falta.</li>'
        + '<li><strong>Tu mes a la vista</strong>Controla ingresos y gastos para saber cuánto puedes apartar.</li>'
        + '<li><strong>Tus datos son tuyos</strong>Sin cuentas: todo se guarda solo en este dispositivo, así que guarda respaldos de vez en cuando.</li></ul>'
        + '<button class="btn primary block" type="button" data-action="onboard-next">Empezar</button>'
        + '<div data-install="bienvenida"></div>'
        + '<a class="btn link" href="privacidad.html">Aviso de privacidad</a></div>';
    }
    if (onboardStep === 2) {
      return '<div class="welcome"><p class="step">Paso 1 de 2</p><h1>¿En qué moneda ahorras?</h1>'
        + '<div class="field"><label for="ob-currency">Moneda</label><select class="input" id="ob-currency">' + currencyOptions(state.currency) + '</select></div>'
        + '<button class="btn primary block" type="button" data-action="onboard-currency">Continuar</button></div>';
    }
    return '<div class="welcome"><p class="step">Paso 2 de 2</p><h1>¿Cuál es tu primera meta?</h1>'
      + goalFormFields(null, 'welcome') + '</div>';
  }

  function viewFatal(message, withDownload) {
    return '<div class="welcome"><h1>No pudimos abrir tus datos</h1><p>' + esc(message) + '</p>'
      + (withDownload ? '<button class="btn primary" type="button" data-action="download-raw">Descargar los datos guardados</button>' : '')
      + '</div>';
  }

  /* ---------- Render y rutas ---------- */

  function render() {
    if (fatalRaw !== null) {
      nav.hidden = true;
      main.innerHTML = viewFatal('La información guardada está dañada. No la hemos borrado: descárgala antes de hacer cualquier otro cambio.', true);
      return;
    }
    if (!state) {
      nav.hidden = true;
      main.innerHTML = viewFatal('Tu navegador está bloqueando el almacenamiento local. Revisa si estás en navegación privada o si tienes bloqueados los datos de sitios.', false);
      return;
    }
    if (!state.onboarded) {
      nav.hidden = true;
      main.innerHTML = viewWelcome();
      const form = main.querySelector('form');
      if (form) bindForm(form, submitGoal(null, () => finishOnboarding()));
      fillInstallSlots();
      window.scrollTo(0, 0);
      return;
    }
    nav.hidden = false;
    const hash = location.hash.replace(/^#/, '') || 'inicio';
    const [route, param] = hash.split('/');
    let html;
    let current = route;
    if (route === 'metas') html = viewMetas();
    else if (route === 'presupuesto') html = viewPresupuesto();
    else if (route === 'ajustes') html = viewAjustes();
    else if (route === 'meta') {
      html = viewMeta(param);
      current = 'metas';
      if (html === null) { location.replace('#metas'); return; }
    } else { html = viewInicio(); current = 'inicio'; }

    main.innerHTML = html;
    main.querySelectorAll('[data-pct]').forEach((el) => { el.style.width = el.dataset.pct + '%'; });
    fillInstallSlots();
    nav.querySelectorAll('a').forEach((a) => {
      if (a.dataset.route === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (lastRoute !== hash) {
      if (lastRoute !== null) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
      lastRoute = hash;
    }
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  /* ---------- Formularios ---------- */

  function bindForm(form, handler) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const error = form.querySelector('.error');
      error.hidden = true;
      const fail = (message, field) => {
        error.textContent = message;
        error.hidden = false;
        const input = field && form.elements[field];
        if (input && input.focus) input.focus();
      };
      handler(new FormData(form), fail);
    });
  }

  function openSheet(html, handler) {
    sheet.innerHTML = html;
    const form = sheet.querySelector('form');
    if (form) bindForm(form, handler);
    sheet.showModal();
  }

  function closeSheet() {
    if (sheet.open) sheet.close();
    sheet.innerHTML = '';
  }

  function ask(opts) {
    return new Promise((resolve) => {
      confirmDlg.innerHTML = '<div class="form"><h2 id="confirm-title">' + esc(opts.title) + '</h2><p>' + esc(opts.body) + '</p>'
        + '<div class="form-actions"><button class="btn" type="button" data-answer="no">Cancelar</button>'
        + '<button class="btn ' + (opts.danger ? 'danger-solid' : 'primary') + '" type="button" data-answer="yes">' + esc(opts.ok) + '</button></div></div>';
      const finish = (answer) => {
        confirmDlg.removeEventListener('click', onClick);
        confirmDlg.removeEventListener('cancel', onCancel);
        confirmDlg.close();
        resolve(answer);
      };
      const onClick = (e) => {
        const btn = e.target.closest('[data-answer]');
        if (btn) finish(btn.dataset.answer === 'yes');
      };
      const onCancel = (e) => { e.preventDefault(); finish(false); };
      confirmDlg.addEventListener('click', onClick);
      confirmDlg.addEventListener('cancel', onCancel);
      confirmDlg.showModal();
    });
  }

  function amountField(name, label, value, help) {
    return '<div class="field"><label for="f-' + name + '">' + label + '</label>'
      + '<input class="input money" id="f-' + name + '" name="' + name + '" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(value) + '">'
      + (help ? '<span class="help">' + help + '</span>' : '') + '</div>';
  }

  function dateField(value) {
    return '<div class="field"><label for="f-date">Fecha</label><input class="input" id="f-date" name="date" type="date" required value="' + esc(value) + '"></div>';
  }

  function noteField(value) {
    return '<div class="field"><label for="f-note">Nota <span class="opt">(opcional)</span></label>'
      + '<input class="input" id="f-note" name="note" maxlength="' + C.MAX_NOTE + '" autocomplete="off" value="' + esc(value) + '"></div>';
  }

  function segField(name, legend, options, selected) {
    return '<div class="field" role="radiogroup" aria-label="' + esc(legend) + '"><div class="seg">' + options.map(([value, text]) => (
      '<label><input type="radio" name="' + name + '" value="' + value + '"' + (value === selected ? ' checked' : '') + '>' + text + '</label>'
    )).join('') + '</div></div>';
  }

  function actions(submitLabel, deleteAction, deleteId) {
    return '<p class="error" role="alert" hidden></p><div class="form-actions">'
      + '<button class="btn" type="button" data-action="close">Cancelar</button>'
      + '<button class="btn primary" type="submit">' + submitLabel + '</button>'
      + (deleteAction ? '<button class="btn danger" type="button" data-action="' + deleteAction + '" data-id="' + esc(deleteId) + '">Eliminar</button>' : '')
      + '</div>';
  }

  /* Metas */

  function goalFormFields(goal, mode) {
    const welcome = mode === 'welcome';
    return '<form class="form" novalidate>'
      + (welcome ? '' : '<h2 id="sheet-title">' + (goal ? 'Editar meta' : 'Nueva meta') + '</h2>')
      + '<div class="field"><label for="f-name">Nombre</label><input class="input" id="f-name" name="name" maxlength="' + C.MAX_NAME + '" autocomplete="off" placeholder="Ej.: Fondo de emergencia" value="' + esc(goal ? goal.name : '') + '"></div>'
      + amountField('target', 'Cuánto quieres juntar', goal ? C.centsToInput(goal.target) : '')
      + '<div class="field"><label for="f-deadline">Fecha límite <span class="opt">(opcional)</span></label><input class="input" id="f-deadline" name="deadline" type="date" value="' + esc(goal && goal.deadline ? goal.deadline : '') + '"></div>'
      + (welcome
        ? '<p class="error" role="alert" hidden></p><div class="form-actions"><button class="btn" type="button" data-action="onboard-skip">Omitir por ahora</button><button class="btn primary" type="submit">Crear meta</button></div>'
        : actions(goal ? 'Guardar' : 'Crear meta', goal ? 'delete-goal' : null, goal ? goal.id : null))
      + '</form>';
  }

  function submitGoal(goal, done) {
    return (data, fail) => {
      const name = String(data.get('name')).trim();
      const target = C.parseAmount(data.get('target'));
      const deadline = String(data.get('deadline') || '');
      if (!name) return fail('Ponle un nombre a tu meta.', 'name');
      if (!target) return fail('Escribe un monto mayor que cero.', 'target');
      if (deadline && !C.isDate(deadline)) return fail('Revisa la fecha límite.', 'deadline');
      if (goal) {
        goal.name = name;
        goal.target = target;
        goal.deadline = deadline || null;
      } else {
        state.goals.push({ id: C.newId(), name, target, deadline: deadline || null, createdAt: C.todayISO() });
      }
      save();
      done();
    };
  }

  /* Aportes y retiros */

  function moveForm(goalId, move, type) {
    const goal = state.goals.find((g) => g.id === goalId);
    const current = move ? move.type : type;
    openSheet('<form class="form" novalidate><h2 id="sheet-title">' + esc(goal.name) + '</h2>'
      + segField('type', 'Tipo de movimiento', [['in', 'Aportar'], ['out', 'Retirar']], current)
      + amountField('amount', 'Monto', move ? C.centsToInput(move.amount) : '')
      + dateField(move ? move.date : C.todayISO())
      + noteField(move ? move.note : '')
      + actions('Guardar', move ? 'delete-move' : null, move ? move.id : null)
      + '</form>', (data, fail) => {
      const nextType = data.get('type');
      const amount = C.parseAmount(data.get('amount'));
      const date = String(data.get('date'));
      if (!amount) return fail('Escribe un monto mayor que cero.', 'amount');
      if (!C.isDate(date)) return fail('Revisa la fecha.', 'date');
      const base = C.goalBalance(state, goalId) - (move ? C.signed(move) : 0);
      const result = base + (nextType === 'in' ? amount : -amount);
      if (result < 0) return fail('No puedes retirar más de lo ahorrado (' + money(Math.max(base, 0)) + ').', 'amount');
      const note = String(data.get('note')).trim();
      if (move) Object.assign(move, { type: nextType, amount, date, note });
      else state.moves.push({ id: C.newId(), goalId, type: nextType, amount, date, note });
      save();
      closeSheet();
      render();
      if (result >= goal.target && base < goal.target) toast('¡Alcanzaste tu meta “' + goal.name + '”!');
    });
    if (!move) sheet.querySelector('[name="amount"]').focus();
  }

  /* Ingresos y gastos */

  function defaultTxDate() {
    const today = C.todayISO();
    return location.hash.startsWith('#presupuesto') && viewMonth !== today.slice(0, 7) ? viewMonth + '-01' : today;
  }

  function txForm(tx, type) {
    const current = tx ? tx.type : type;
    const catOptions = '<option value="">Sin categoría</option>' + state.categories.map((c) => (
      '<option value="' + esc(c.id) + '"' + (tx && tx.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'
    )).join('');
    openSheet('<form class="form" novalidate><h2 id="sheet-title">' + (tx ? 'Editar movimiento' : 'Nuevo movimiento') + '</h2>'
      + segField('type', 'Tipo de movimiento', [['expense', 'Gasto'], ['income', 'Ingreso']], current)
      + amountField('amount', 'Monto', tx ? C.centsToInput(tx.amount) : '')
      + '<div class="field" id="cat-field"' + (current === 'income' ? ' hidden' : '') + '><label for="f-cat">Categoría</label><select class="input" id="f-cat" name="categoryId">' + catOptions + '</select></div>'
      + dateField(tx ? tx.date : defaultTxDate())
      + noteField(tx ? tx.note : '')
      + actions('Guardar', tx ? 'delete-tx' : null, tx ? tx.id : null)
      + '</form>', (data, fail) => {
      const nextType = data.get('type');
      const amount = C.parseAmount(data.get('amount'));
      const date = String(data.get('date'));
      if (!amount) return fail('Escribe un monto mayor que cero.', 'amount');
      if (!C.isDate(date)) return fail('Revisa la fecha.', 'date');
      const categoryId = nextType === 'expense' ? (data.get('categoryId') || null) : null;
      const note = String(data.get('note')).trim();
      if (tx) Object.assign(tx, { type: nextType, amount, categoryId, date, note });
      else state.txs.push({ id: C.newId(), type: nextType, amount, categoryId, date, note });
      save();
      closeSheet();
      render();
    });
    sheet.querySelectorAll('[name="type"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        sheet.querySelector('#cat-field').hidden = radio.value === 'income';
      });
    });
    if (!tx) sheet.querySelector('[name="amount"]').focus();
  }

  /* Categorías */

  function categoryForm(cat) {
    openSheet('<form class="form" novalidate><h2 id="sheet-title">' + (cat ? 'Editar categoría' : 'Nueva categoría') + '</h2>'
      + '<div class="field"><label for="f-name">Nombre</label><input class="input" id="f-name" name="name" maxlength="' + C.MAX_NAME + '" autocomplete="off" value="' + esc(cat ? cat.name : '') + '"></div>'
      + amountField('budget', 'Límite mensual <span class="opt">(opcional)</span>', cat && cat.budget ? C.centsToInput(cat.budget) : '', 'Se aplica a todos los meses.')
      + actions('Guardar', cat ? 'delete-category' : null, cat ? cat.id : null)
      + '</form>', (data, fail) => {
      const name = String(data.get('name')).trim();
      const rawBudget = String(data.get('budget')).trim();
      const budget = rawBudget ? C.parseAmount(rawBudget) : 0;
      if (!name) return fail('Ponle un nombre a la categoría.', 'name');
      if (budget === null) return fail('Revisa el límite mensual.', 'budget');
      const duplicate = state.categories.some((c) => c !== cat && c.name.toLowerCase() === name.toLowerCase());
      if (duplicate) return fail('Ya tienes una categoría con ese nombre.', 'name');
      if (cat) Object.assign(cat, { name, budget });
      else state.categories.push({ id: C.newId(), name, budget });
      save();
      closeSheet();
      render();
    });
  }

  /* ---------- Respaldo ---------- */

  function downloadFile(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportBackup() {
    const today = C.todayISO();
    state.lastBackup = today;
    save();
    downloadFile('av-ahorros-respaldo-' + today + '.json', JSON.stringify(Object.assign({ app: 'alcancia' }, state), null, 2));
    render();
    toast('Respaldo descargado. Guárdalo en un lugar seguro.');
  }

  async function importBackup(file) {
    if (file.size > MAX_IMPORT_BYTES) { toast('El archivo es demasiado grande para ser un respaldo.'); return; }
    let incoming;
    try {
      incoming = C.sanitizeBackup(JSON.parse(await file.text()));
    } catch (e) {
      toast(e instanceof SyntaxError ? 'El archivo no es un respaldo de AV ahorros.' : e.message);
      return;
    }
    const yes = await ask({
      title: '¿Restaurar este respaldo?',
      body: 'Reemplazará todo lo que hay en este dispositivo con ' + plural(incoming.goals.length, 'meta', 'metas') + ' y '
        + plural(incoming.moves.length + incoming.txs.length, 'movimiento', 'movimientos') + '.',
      ok: 'Restaurar',
      danger: true,
    });
    if (!yes) return;
    state = incoming;
    save();
    render();
    toast('Respaldo restaurado.');
  }

  /* ---------- Bienvenida ---------- */

  function finishOnboarding() {
    state.onboarded = true;
    save();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    location.hash = '#inicio';
    render();
  }

  /* ---------- Acciones ---------- */

  const handlers = {
    close: closeSheet,
    'onboard-next': () => { onboardStep = 2; render(); },
    'onboard-currency': () => {
      state.currency = document.getElementById('ob-currency').value;
      onboardStep = 3;
      render();
    },
    'onboard-skip': finishOnboarding,
    'new-goal': () => openSheet(goalFormFields(null), submitGoal(null, () => { closeSheet(); render(); })),
    'edit-goal': (d) => {
      const goal = state.goals.find((g) => g.id === d.id);
      if (goal) openSheet(goalFormFields(goal), submitGoal(goal, () => { closeSheet(); render(); }));
    },
    'delete-goal': async (d) => {
      const goal = state.goals.find((g) => g.id === d.id);
      if (!goal) return;
      const yes = await ask({
        title: '¿Eliminar esta meta?',
        body: 'Se borrarán “' + goal.name + '” y su historial, que dejará de contar en tus resúmenes. No se puede deshacer.',
        ok: 'Eliminar meta',
        danger: true,
      });
      if (!yes) return;
      state.moves = state.moves.filter((m) => m.goalId !== goal.id);
      state.goals = state.goals.filter((g) => g !== goal);
      save();
      closeSheet();
      location.hash = '#metas';
      toast('Meta eliminada.');
    },
    'new-move': (d) => moveForm(d.id, null, d.type),
    'edit-move': (d) => {
      const move = state.moves.find((m) => m.id === d.id);
      if (move) moveForm(move.goalId, move);
    },
    'delete-move': async (d) => {
      const move = state.moves.find((m) => m.id === d.id);
      if (!move) return;
      if (C.goalBalance(state, move.goalId) - C.signed(move) < 0) {
        toast('No se puede eliminar: el saldo de la meta quedaría negativo.');
        return;
      }
      const yes = await ask({ title: '¿Eliminar este movimiento?', body: 'Dejará de contar en el saldo de la meta.', ok: 'Eliminar', danger: true });
      if (!yes) return;
      state.moves = state.moves.filter((m) => m !== move);
      save();
      closeSheet();
      render();
    },
    'new-tx': (d) => txForm(null, d.type),
    'edit-tx': (d) => {
      const tx = state.txs.find((t) => t.id === d.id);
      if (tx) txForm(tx);
    },
    'delete-tx': async (d) => {
      const yes = await ask({ title: '¿Eliminar este movimiento?', body: 'Dejará de contar en tu presupuesto.', ok: 'Eliminar', danger: true });
      if (!yes) return;
      state.txs = state.txs.filter((t) => t.id !== d.id);
      save();
      closeSheet();
      render();
    },
    'new-category': () => categoryForm(null),
    'edit-category': (d) => {
      const cat = state.categories.find((c) => c.id === d.id);
      if (cat) categoryForm(cat);
    },
    'delete-category': async (d) => {
      const cat = state.categories.find((c) => c.id === d.id);
      if (!cat) return;
      const yes = await ask({ title: '¿Eliminar esta categoría?', body: 'Sus gastos se conservarán como “Sin categoría”.', ok: 'Eliminar', danger: true });
      if (!yes) return;
      state.txs.forEach((t) => { if (t.categoryId === cat.id) t.categoryId = null; });
      state.categories = state.categories.filter((c) => c !== cat);
      save();
      closeSheet();
      render();
    },
    month: (d) => { viewMonth = C.shiftMonth(viewMonth, Number(d.delta)); render(); },
    export: exportBackup,
    import: () => document.getElementById('import-file').click(),
    install: async () => {
      if (!installPrompt) return;
      const prompt = installPrompt;
      installPrompt = null;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch (e) {
        toast('No se pudo abrir la instalación. Búscala en el menú de tu navegador.');
      }
      fillInstallSlots();
    },
    'install-hide': () => {
      try { localStorage.setItem(INSTALL_HIDDEN_KEY, '1'); } catch (e) { /* solo se oculta en esta visita */ }
      const slot = main.querySelector('[data-install="inicio"]');
      if (slot) slot.innerHTML = '';
    },
    erase: async () => {
      const yes = await ask({
        title: '¿Borrar todos tus datos?',
        body: 'Se eliminará todo de este dispositivo. Si no tienes un respaldo, no podrás recuperarlo.',
        ok: 'Borrar todo',
        danger: true,
      });
      if (!yes) return;
      try {
        localStorage.removeItem(KEY);
        localStorage.removeItem(INSTALL_HIDDEN_KEY);
      } catch (e) { /* el estado se reinicia igualmente */ }
      state = load().state || C.emptyState();
      onboardStep = 1;
      lastRoute = null;
      location.hash = '';
      render();
    },
    'download-raw': () => downloadFile('av-ahorros-datos-danados.json', fatalRaw),
  };

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const handler = handlers[el.dataset.action];
    if (handler) handler(el.dataset);
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id === 'import-file' && event.target.files[0]) {
      const file = event.target.files[0];
      event.target.value = '';
      await importBackup(file);
    }
    if (event.target.id === 'set-currency') {
      state.currency = event.target.value;
      save();
      render();
      toast('Moneda actualizada. Los montos no se convirtieron.');
    }
  });

  window.addEventListener('hashchange', () => { closeSheet(); render(); });

  /* Mantiene sincronizadas otras pestañas abiertas para que una no sobrescriba a la otra. */
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    const result = load();
    if (result.state) {
      state = result.state;
      closeSheet();
      render();
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    fillInstallSlots();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    justInstalled = true;
    fillInstallSlots();
    toast('AV ahorros quedó instalada.');
  });

  /* ---------- Arranque ---------- */

  const initial = load();
  if (initial.corrupt) fatalRaw = initial.corrupt;
  else if (initial.state) state = initial.state;
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
