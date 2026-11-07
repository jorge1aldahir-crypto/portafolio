/* Interfaz de AV ahorros. Todo texto del usuario pasa por esc() antes de llegar al HTML. */
(function () {
  'use strict';

  const C = window.AlcanciaCore;
  const KEY = 'alcancia.v1';
  const VERSION = '1.7.0';
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
  let autoCustomOpen = false;
  let statsCustomOpen = false;
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

  function autoCard() {
    const auto = state.auto;
    const preset = auto.everyDays === 7 || auto.everyDays === 15;
    const custom = autoCustomOpen || !preset;
    let body;
    if (!auto.enabled) {
      body = '<p class="muted small">Cada cierto número de días pasa el dinero que te sobra (ingresos menos gastos) a las metas que elijas, repartido en los porcentajes que quieras.</p>';
    } else {
      const { targets, parts } = C.autoPreview(state, C.todayISO());
      let status;
      if (!state.goals.length) {
        status = 'Crea una meta para empezar.';
      } else if (!C.activeGoals(state).length) {
        status = 'Todas tus metas están completas, así que no hay a dónde pasar el dinero.';
      } else if (!targets.length) {
        status = auto.splits.length
          ? '<span class="over">Las metas que elegiste ya están completas.</span> Elige otras; mientras tanto, el dinero espera.'
          : '<span class="over">Elige a qué metas pasar el dinero.</span> Tienes varias en curso; mientras tanto, el dinero espera.';
      } else {
        status = 'Próximo traspaso: <strong>' + esc(formatDate(auto.next)) + '</strong>. '
          + (parts.length
            ? 'Hoy se pasarían ' + parts.map((p) => '<strong class="money">' + money(p.amount) + '</strong> a “' + esc(p.goal.name) + '”').join(', ') + '.'
            : 'Por ahora no hay dinero disponible para pasar.');
      }
      const shown = C.normalizeSplits(targets.map((t) => ({ goalId: t.goal.id, pct: t.weight })));
      const reparto = shown.length
        ? '<ul class="split-list">' + shown.map((s) => (
          '<li><span>' + esc(state.goals.find((g) => g.id === s.goalId).name) + '</span><strong>' + s.pct + '%</strong></li>'
        )).join('') + '</ul>'
        : '<p class="muted small">Ninguna todavía.</p>';
      body = '<div class="auto-split"><p class="field-label">Metas que reciben el dinero</p>' + reparto
        + '<button class="btn" type="button" data-action="auto-splits">Elegir metas y porcentajes</button></div>'
        + '<p class="field-label">Pasar el dinero cada</p>' + segField('auto-every', 'Frecuencia', [['7', '7 días'], ['15', '15 días'], ['other', 'Otro']], custom ? 'other' : String(auto.everyDays))
        + (custom
          ? '<div class="field"><label for="auto-days">Cada cuántos días</label><div class="inline">'
            + '<input class="input" id="auto-days" type="number" inputmode="numeric" min="1" max="' + C.MAX_AUTO_DAYS + '" value="' + (preset ? '' : auto.everyDays) + '">'
            + '<button class="btn" type="button" data-action="auto-days">Guardar</button></div></div>'
          : '')
        + '<p class="auto-status">' + status + '</p>'
        + '<p class="muted small">Cuenta lo que registres desde el ' + esc(formatDate(auto.since)) + '. Se aplica cuando abres la app: si pasaron varios periodos, se pone al día.</p>';
    }
    return '<section class="card setting" aria-labelledby="auto-title"><div class="auto-head"><h2 id="auto-title">Ahorro automático</h2>'
      + '<label class="switch"><input type="checkbox" id="auto-on" role="switch" aria-label="Activar ahorro automático"' + (auto.enabled ? ' checked' : '') + '><span aria-hidden="true"></span></label></div>'
      + body + '</section>';
  }

  function viewMetas() {
    const withBalance = state.goals.map((g) => ({ g, reached: C.goalBalance(state, g.id) >= g.target }));
    const active = withBalance.filter((x) => !x.reached).map((x) => x.g);
    const reached = withBalance.filter((x) => x.reached).map((x) => x.g);
    return '<div class="head-row"><h1 class="page-title">Metas</h1><button class="btn primary" type="button" data-action="new-goal">Nueva meta</button></div>'
      + autoCard()
      + (state.goals.length
        ? '<p class="muted">Llevas <strong class="money">' + money(C.totalSaved(state)) + '</strong> ahorrados en total.</p>'
        : '<div class="empty"><p>Crea tu primera meta: un viaje, un fondo de emergencia o lo que tengas en mente.</p></div>')
      + (active.length ? '<div class="stack">' + active.map(goalCard).join('') + '</div>' : '')
      + (active.length ? statsTable(active) : '')
      + (reached.length ? '<section class="section"><h2 class="section-title">Alcanzadas</h2><div class="stack">' + reached.map(goalCard).join('') + '</div></section>' : '');
  }

  /* ---------- Estadísticas ---------- */

  const STAT_REASON = {
    done: '¡Meta alcanzada!',
    few: 'Haz al menos 2 aportes para calcular',
    noProgress: 'Sin avance: los retiros superan a los aportes',
    sameDay: 'Haz aportes en días distintos para calcular',
    tooLong: 'Más de 100 años a este ritmo',
  };

  function durationText(days) {
    if (days <= 0) return 'hoy';
    if (days < 60) return plural(days, 'día', 'días');
    const months = Math.round(days / 30.44);
    if (months < 24) return plural(months, 'mes', 'meses');
    const rest = months % 12;
    return plural(Math.floor(months / 12), 'año', 'años') + (rest ? ' y ' + plural(rest, 'mes', 'meses') : '');
  }

  function everyText(days) {
    const rounded = Math.max(1, Math.round(days));
    return rounded === 1 ? 'Cada día' : 'Cada ' + rounded + ' días';
  }

  function estimateText(st) {
    return st.daysLeft === null ? STAT_REASON[st.reason] : '≈ ' + durationText(st.daysLeft);
  }

  /* Periodo para calcular cuánto aportar: el que elija la persona; si no eligió, el del ahorro automático o 7 días. */
  function statsEvery() {
    return state.statsEvery || (state.auto.enabled ? state.auto.everyDays : 7);
  }

  function periodText(every) {
    return every === 1 ? 'cada día' : 'cada ' + every + ' días';
  }

  function neededText(goal, st, need) {
    if (need.reason === 'done') return '—';
    if (need.reason === 'noDeadline') return 'Ponle fecha límite para calcularlo';
    if (need.reason === 'past') return '<span class="over">La fecha límite ya pasó</span><span class="sub">' + esc(formatDate(goal.deadline)) + '</span>';
    const pace = st.onTime === true ? '<span class="done">A tu ritmo, llegas a tiempo</span>'
      : st.onTime === false ? '<span class="over">A tu ritmo, llegas tarde</span>' : '';
    return '<strong>' + money(need.amount) + '</strong> ' + periodText(need.every)
      + '<span class="sub">' + plural(need.periods, 'aporte', 'aportes') + ' hasta el ' + esc(formatDate(goal.deadline)) + '</span>'
      + (pace ? '<span class="sub">' + pace + '</span>' : '');
  }

  function statsTable(goals) {
    const today = C.todayISO();
    const every = statsEvery();
    const preset = every === 1 || every === 7 || every === 15;
    const custom = statsCustomOpen || !preset;
    const cell = (label, html) => '<td data-label="' + label + '"><span class="val">' + html + '</span></td>';
    const rows = goals.map((g) => {
      const st = C.goalStats(state, g, today);
      const need = C.neededPerPeriod(state, g, today, every);
      return '<tr><th scope="row"><a href="#meta/' + esc(g.id) + '">' + esc(g.name) + '</a></th>'
        + cell('Promedio por aporte', (st.average > 0 ? money(st.average) : '—') + '<span class="sub">' + plural(st.count, 'aporte', 'aportes') + '</span>')
        + cell('Frecuencia', st.everyDays ? everyText(st.everyDays) : '—')
        + cell('Falta', money(st.remaining))
        + cell('Tiempo estimado', esc(estimateText(st)) + (st.eta ? '<span class="sub">' + esc(formatDate(st.eta)) + '</span>' : ''))
        + cell('Para la fecha límite', neededText(g, st, need))
        + '</tr>';
    }).join('');
    return '<section class="section"><h2 class="section-title">Estadísticas</h2>'
      + '<p class="muted small">Con el promedio de tus aportes y cada cuánto los haces, calculamos cuánto te falta para cada meta. Si la meta tiene fecha límite, también te decimos cuánto aportar en cada periodo para llegar a tiempo.</p>'
      + '<div class="stats-every"><p class="field-label">Calcular cuánto aportar</p>'
      + segField('stats-every', 'Periodo para calcular cuánto aportar', [['1', 'Cada día'], ['7', '7 días'], ['15', '15 días'], ['other', 'Otro']], custom ? 'other' : String(every))
      + (custom
        ? '<div class="field"><label for="stats-days">Cada cuántos días</label><div class="inline">'
          + '<input class="input" id="stats-days" type="number" inputmode="numeric" min="1" max="' + C.MAX_AUTO_DAYS + '" value="' + (preset ? '' : every) + '">'
          + '<button class="btn" type="button" data-action="stats-days">Calcular</button></div></div>'
        : '')
      + '</div>'
      + '<div class="table-wrap"><table class="stats"><thead><tr><th scope="col">Meta</th><th scope="col">Promedio por aporte</th><th scope="col">Frecuencia</th>'
      + '<th scope="col">Falta</th><th scope="col">Tiempo estimado</th><th scope="col">Para la fecha límite</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></section>';
  }

  function goalEstimateCard(goal) {
    const st = C.goalStats(state, goal, C.todayISO());
    if (st.reason === 'done') return '';
    let text;
    if (st.daysLeft === null) {
      text = '<p>' + esc(STAT_REASON[st.reason]) + '.</p>';
    } else {
      text = '<p>A este ritmo llegarías en <strong>' + esc(durationText(st.daysLeft)) + '</strong>, alrededor del <strong>' + esc(formatDate(st.eta)) + '</strong>.</p>';
      if (st.onTime === false) text += '<p class="over">Eso es después de tu fecha límite.</p>';
      if (st.onTime === true) text += '<p class="done">Llegarías antes de tu fecha límite.</p>';
    }
    const need = C.neededPerPeriod(state, goal, C.todayISO(), statsEvery());
    if (need.amount !== null) {
      text += '<p>Para llegar el ' + esc(formatDate(goal.deadline)) + ': <strong class="money">' + money(need.amount) + ' ' + periodText(need.every) + '</strong> ('
        + plural(need.periods, 'aporte', 'aportes') + '). Cambia el periodo en Metas → Estadísticas.</p>';
    } else if (need.reason === 'past') {
      text += '<p class="over">La fecha límite ya pasó: ponle una nueva para calcular cuánto aportar.</p>';
    }
    const detail = st.count
      ? plural(st.count, 'aporte', 'aportes') + (st.average > 0 ? ' · promedio de ' + money(st.average) : '') + (st.everyDays ? ' · ' + everyText(st.everyDays).toLowerCase() : '')
      : 'Sin aportes todavía';
    return '<section class="card setting"><h2>Estimación</h2>' + text + '<p class="muted small money">' + detail + '</p></section>';
  }

  /* ---------- Ojiva: avance acumulado de una meta ---------- */

  function ogivePoints(goal) {
    const moves = state.moves.filter((m) => m.goalId === goal.id);
    if (!moves.length) return null;
    const byDate = new Map();
    moves.forEach((m) => byDate.set(m.date, (byDate.get(m.date) || 0) + C.signed(m)));
    const dates = [...byDate.keys()].sort();
    const start = goal.createdAt < dates[0] ? goal.createdAt : dates[0];
    const points = [{ date: start, value: 0, change: 0, origin: true }];
    let total = 0;
    dates.forEach((date) => {
      total += byDate.get(date);
      points.push({ date, value: total, change: byDate.get(date) });
    });
    return points;
  }

  function niceStep(raw) {
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / power;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
  }

  /* Un mismo estilo para todo el eje: completo por debajo de 10,000 y abreviado si el eje llega a esa cifra. */
  function moneyShort(cents, big) {
    const fmt = (value, digits) => new Intl.NumberFormat(lang, {
      style: 'currency', currency: state.currency, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0, maximumFractionDigits: digits,
    }).format(value);
    const units = cents / 100;
    if (!big || !units) return fmt(units, 0);
    return units >= 1000000 ? fmt(units / 1000000, 1) + ' M' : fmt(units / 1000, 1) + ' mil';
  }

  function shortDate(iso, withYear) {
    const opts = withYear ? { day: 'numeric', month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' };
    return new Intl.DateTimeFormat(lang, opts).format(isoToDate(iso));
  }

  function ogiveCard(goal) {
    if (!ogivePoints(goal)) return '';
    return '<section class="card setting"><h2 id="og-title">Avance acumulado</h2>'
      + '<p class="muted small">Ojiva: lo que llevas ahorrado en total en cada fecha. La línea punteada que sube es la proyección a tu ritmo actual.</p>'
      + '<div class="ogive" data-ogive="' + esc(goal.id) + '" tabindex="0" role="group" aria-labelledby="og-title" aria-describedby="og-hint"></div>'
      + '<p class="muted small" id="og-hint">Toca o pasa el cursor por la gráfica, o usa las flechas del teclado, para ver cada fecha.</p></section>';
  }

  function drawOgives() {
    main.querySelectorAll('[data-ogive]').forEach(drawOgive);
  }

  function drawOgive(slot) {
    const goal = state.goals.find((g) => g.id === slot.dataset.ogive);
    const points = goal && ogivePoints(goal);
    if (!points) { slot.innerHTML = ''; return; }
    const today = C.todayISO();
    const st = C.goalStats(state, goal, today);
    const last = points[points.length - 1];
    const W = Math.max(280, Math.floor(slot.clientWidth));
    const H = W < 480 ? 220 : 260;
    const start = points[0].date;
    const end = [today, last.date, st.eta, goal.deadline].filter(Boolean).reduce((a, b) => (b > a ? b : a));
    const span = Math.max(1, C.daysBetween(start, end));
    const top = Math.max(goal.target, ...points.map((p) => p.value));
    const step = niceStep(top / 4);
    const yMax = Math.ceil(top / step) * step;
    const ticks = [];
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    const compact = yMax >= 1000000;
    const pad = { t: 30, r: 16, b: 30, l: 14 + Math.max(...ticks.map((v) => moneyShort(v, compact).length)) * 7 };
    const x = (d) => pad.l + (C.daysBetween(start, d) / span) * (W - pad.l - pad.r);
    const y = (v) => H - pad.b - (Math.max(0, v) / yMax) * (H - pad.t - pad.b);
    const n = (v) => Math.round(v * 10) / 10;
    const withYear = start.slice(0, 4) !== end.slice(0, 4);

    let svg = '';
    ticks.forEach((v) => {
      svg += '<line class="og-grid" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + n(y(v)) + '" y2="' + n(y(v)) + '"/>'
        + '<text class="og-axis" x="' + (pad.l - 8) + '" y="' + n(y(v) + 4) + '" text-anchor="end">' + esc(moneyShort(v, compact)) + '</text>';
    });
    const xTicks = [...new Set([start, C.addDays(start, Math.round(span / 2)), end])];
    xTicks.forEach((d, i) => {
      const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle';
      svg += '<text class="og-axis" x="' + n(x(d)) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' + esc(shortDate(d, withYear)) + '</text>';
    });
    if (goal.deadline) {
      const dx = n(x(goal.deadline));
      svg += '<line class="og-deadline" x1="' + dx + '" x2="' + dx + '" y1="' + pad.t + '" y2="' + (H - pad.b) + '"/>'
        + '<text class="og-note" x="' + (dx > pad.l + 90 ? dx - 6 : dx + 6) + '" y="' + (H - pad.b - 8) + '" text-anchor="' + (dx > pad.l + 90 ? 'end' : 'start') + '">Fecha límite</text>';
    }
    const ty = n(y(goal.target));
    const targetText = 'Meta ' + money(goal.target);
    const etaText = st.daysLeft !== null ? '≈ ' + shortDate(st.eta, true) : '';
    /* Si la fecha estimada chocaría con el texto de la meta, este baja bajo su línea, donde la gráfica está vacía. */
    const textWidth = (s) => s.length * 6.6;
    const etaLeft = etaText ? x(st.eta) - 8 - textWidth(etaText) : Infinity;
    const targetBelow = etaLeft < pad.l + 4 + textWidth(targetText) + 10;
    svg += '<line class="og-target" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + ty + '" y2="' + ty + '"/>'
      + '<text class="og-note" x="' + (pad.l + 4) + '" y="' + (targetBelow ? ty + 16 : ty - 6) + '">' + esc(targetText) + '</text>';

    const line = points.map((p) => [x(p.date), y(p.value)]);
    if (today > last.date) line.push([x(today), y(last.value)]);
    const pts = line.map(([a, b]) => n(a) + ',' + n(b)).join(' ');
    svg += '<path class="og-area" d="M' + n(line[0][0]) + ',' + n(y(0)) + ' L' + pts.replace(/ /g, ' L') + ' L' + n(line[line.length - 1][0]) + ',' + n(y(0)) + ' Z"/>'
      + '<polyline class="og-line" points="' + pts + '"/>';

    if (st.daysLeft !== null) {
      const px = n(x(st.eta));
      svg += '<line class="og-proj" x1="' + n(line[line.length - 1][0]) + '" y1="' + n(y(last.value)) + '" x2="' + px + '" y2="' + ty + '"/>'
        + '<circle class="og-proj-dot" cx="' + px + '" cy="' + ty + '" r="4"/>'
        + '<text class="og-note" x="' + (px - 8) + '" y="' + (ty - 8) + '" text-anchor="end">' + esc(etaText) + '</text>';
    }
    const real = points.slice(1);
    if (real.length <= 40) {
      real.forEach((p) => { svg += '<circle class="og-dot" cx="' + n(x(p.date)) + '" cy="' + n(y(p.value)) + '" r="4"/>'; });
    }
    const lx = x(last.date);
    const labelLeft = st.daysLeft !== null || lx > W - 90;
    svg += '<text class="og-label" x="' + n(labelLeft ? lx - 8 : lx + 8) + '" y="' + n(y(last.value) - 10) + '" text-anchor="' + (labelLeft ? 'end' : 'start') + '">' + esc(money(last.value)) + '</text>'
      + '<line class="og-cross" y1="' + pad.t + '" y2="' + (H - pad.b) + '" visibility="hidden"/>'
      + '<circle class="og-focus" r="5" visibility="hidden"/>'
      + '<rect class="og-hit" x="' + pad.l + '" y="0" width="' + (W - pad.l - pad.r) + '" height="' + H + '"/>';

    const summary = 'Avance acumulado de ' + goal.name + ': ' + money(last.value) + ' al ' + formatDate(last.date) + ', de una meta de ' + money(goal.target) + '.'
      + (st.daysLeft !== null ? ' A tu ritmo actual llegarías alrededor del ' + formatDate(st.eta) + '.' : '');
    slot.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(summary) + '">' + svg + '</svg><div class="og-tip" hidden></div>';

    const svgEl = slot.querySelector('svg');
    const cross = slot.querySelector('.og-cross');
    const focus = slot.querySelector('.og-focus');
    const tip = slot.querySelector('.og-tip');
    let current = -1;
    const show = (i) => {
      current = Math.max(0, Math.min(points.length - 1, i));
      const p = points[current];
      const px = x(p.date);
      const py = y(p.value);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      focus.setAttribute('cx', px); focus.setAttribute('cy', py); focus.setAttribute('visibility', 'visible');
      tip.textContent = '';
      const value = document.createElement('strong');
      value.textContent = money(p.value);
      tip.append(value, formatDate(p.date));
      if (!p.origin) {
        const change = document.createElement('span');
        change.textContent = (p.change >= 0 ? '+' : '−') + money(Math.abs(p.change)) + ' ese día';
        tip.append(change);
      } else {
        const change = document.createElement('span');
        change.textContent = 'Inicio';
        tip.append(change);
      }
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      tip.style.left = Math.max(0, Math.min(W - tw, px - tw / 2)) + 'px';
      tip.style.top = Math.max(0, py - th - 14) + 'px';
    };
    const hide = () => {
      current = -1;
      cross.setAttribute('visibility', 'hidden');
      focus.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    const nearest = (event) => {
      const px = event.clientX - svgEl.getBoundingClientRect().left;
      let best = 0;
      points.forEach((p, i) => { if (Math.abs(x(p.date) - px) < Math.abs(x(points[best].date) - px)) best = i; });
      show(best);
    };
    svgEl.addEventListener('pointermove', nearest);
    svgEl.addEventListener('pointerdown', nearest);
    svgEl.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') hide(); });
    slot.onfocus = () => show(points.length - 1);
    slot.onblur = hide;
    slot.onkeydown = (event) => {
      const moves = { ArrowLeft: -1, ArrowRight: 1 };
      if (event.key in moves) { event.preventDefault(); show((current < 0 ? points.length - 1 : current) + moves[event.key]); }
      if (event.key === 'Home') { event.preventDefault(); show(0); }
      if (event.key === 'End') { event.preventDefault(); show(points.length - 1); }
      if (event.key === 'Escape') hide();
    };
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
      + goalEstimateCard(goal)
      + ogiveCard(goal)
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
    drawOgives();
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
      if (result >= goal.target && base < goal.target) {
        toast('¡Alcanzaste tu meta “' + goal.name + '”!');
      } else if (nextType === 'in' && !move) {
        const st = C.goalStats(state, goal, C.todayISO());
        if (st.daysLeft !== null) toast('A este ritmo llegarías a “' + goal.name + '” en ' + durationText(st.daysLeft) + '.');
      }
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
    applyAuto();
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
      state.auto.splits = C.normalizeSplits(state.auto.splits.filter((s) => s.goalId !== goal.id));
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
    'auto-days': () => {
      const input = document.getElementById('auto-days');
      const days = Number(input.value);
      if (!Number.isInteger(days) || days < 1 || days > C.MAX_AUTO_DAYS) {
        toast('Escribe un número de días entre 1 y ' + C.MAX_AUTO_DAYS + '.');
        input.focus();
        return;
      }
      setAutoEvery(days);
    },
    'stats-days': () => {
      const input = document.getElementById('stats-days');
      const days = Number(input.value);
      if (!Number.isInteger(days) || days < 1 || days > C.MAX_AUTO_DAYS) {
        toast('Escribe un número de días entre 1 y ' + C.MAX_AUTO_DAYS + '.');
        input.focus();
        return;
      }
      setStatsEvery(days);
    },
    'auto-splits': splitsForm,
    'split-equal': () => {
      const checked = splitRows().filter((r) => r.on.checked);
      checked.forEach((r, i) => {
        r.pct.value = Math.floor(100 / checked.length) + (i < 100 % checked.length ? 1 : 0);
      });
      updateSplitTotal();
    },
  };

  /* ---------- Reparto entre metas ---------- */

  function splitRows() {
    return [...sheet.querySelectorAll('.split-row')].map((row) => ({
      id: row.dataset.goal,
      on: row.querySelector('input[type="checkbox"]'),
      pct: row.querySelector('input[type="number"]'),
    }));
  }

  function updateSplitTotal() {
    const rows = splitRows();
    rows.forEach((r) => { r.pct.disabled = !r.on.checked; });
    const checked = rows.filter((r) => r.on.checked);
    if (checked.length === 1 && !checked[0].pct.value) checked[0].pct.value = 100;
    const total = checked.reduce((sum, r) => sum + (Number(r.pct.value) || 0), 0);
    const el = sheet.querySelector('.split-total');
    el.textContent = 'Total: ' + total + '%' + (total === 100 ? '' : ' (debe ser 100%)');
    el.classList.toggle('over', total !== 100);
  }

  function splitsForm() {
    const goals = C.activeGoals(state);
    if (!goals.length) {
      toast(state.goals.length ? 'Todas tus metas están completas. Crea una nueva.' : 'Primero crea una meta.');
      return;
    }
    const current = new Map(state.auto.splits.map((s) => [s.goalId, s.pct]));
    if (!current.size && goals.length === 1) current.set(goals[0].id, 100);
    const rows = goals.map((g) => {
      const pct = current.get(g.id);
      return '<div class="split-row" data-goal="' + esc(g.id) + '">'
        + '<label class="split-check"><input type="checkbox" name="on-' + esc(g.id) + '"' + (pct ? ' checked' : '') + '><span>' + esc(g.name) + '</span></label>'
        + '<span class="split-pct"><input class="input money" name="pct-' + esc(g.id) + '" type="number" inputmode="numeric" min="1" max="100" value="' + (pct || '') + '" aria-label="Porcentaje para ' + esc(g.name) + '"><span aria-hidden="true">%</span></span></div>';
    }).join('');
    openSheet('<form class="form" novalidate><h2 id="sheet-title">¿A qué metas pasar el dinero?</h2>'
      + '<p class="help">Elige una o varias y reparte el 100%. Las que no marques no reciben nada automático: puedes seguir aportándoles a mano. Si una elegida se completa, su parte se reparte entre las demás.</p>'
      + '<div class="split-rows">' + rows + '</div>'
      + '<div class="head-row"><p class="split-total" aria-live="polite"></p><button class="btn link" type="button" data-action="split-equal">Repartir en partes iguales</button></div>'
      + actions('Guardar')
      + '</form>', (data, fail) => {
      const chosen = [];
      for (const g of goals) {
        if (!data.get('on-' + g.id)) continue;
        const pct = Number(data.get('pct-' + g.id));
        if (!Number.isInteger(pct) || pct < 1 || pct > 100) return fail('Revisa el porcentaje de “' + g.name + '”: debe ser un número entero de 1 a 100.', 'pct-' + g.id);
        chosen.push({ goalId: g.id, pct });
      }
      if (!chosen.length) return fail('Elige al menos una meta.');
      const total = chosen.reduce((sum, s) => sum + s.pct, 0);
      if (total !== 100) return fail('Los porcentajes deben sumar 100%. Ahora suman ' + total + '%.');
      state.auto.splits = chosen;
      save();
      closeSheet();
      render();
      toast('Reparto guardado.');
    });
    sheet.querySelector('form').addEventListener('input', updateSplitTotal);
    updateSplitTotal();
  }

  /* ---------- Ahorro automático ---------- */

  function setStatsEvery(days) {
    state.statsEvery = days;
    statsCustomOpen = days !== 1 && days !== 7 && days !== 15;
    save();
    render();
    refocus(statsCustomOpen ? '#stats-days' : '[name="stats-every"]:checked');
  }

  function setAutoEvery(days) {
    state.auto.everyDays = days;
    state.auto.next = C.addDays(C.todayISO(), days);
    autoCustomOpen = days !== 7 && days !== 15;
    save();
    render();
    refocus('[name="auto-every"]:checked');
    toast('Ahora cada ' + plural(days, 'día', 'días') + '. Próximo traspaso: ' + formatDate(state.auto.next) + '.');
  }

  function setAutoEnabled(on) {
    const today = C.todayISO();
    const everyDays = state.auto.everyDays || 7;
    const splits = state.auto.splits || [];
    state.auto = on
      ? { enabled: true, everyDays, since: today, next: C.addDays(today, everyDays), splits }
      : { enabled: false, everyDays, since: null, next: null, splits };
    autoCustomOpen = false;
    save();
    render();
    refocus('#auto-on');
    toast(on ? 'Ahorro automático activado. Primer traspaso: ' + formatDate(state.auto.next) + '.' : 'Ahorro automático desactivado.');
  }

  function refocus(selector) {
    const el = main.querySelector(selector);
    if (el) el.focus();
  }

  /* Hace los traspasos que tocan. No corre con un formulario abierto para no cambiar los datos que se editan. */
  function applyAuto() {
    if (!state || !state.onboarded || !state.auto.enabled || sheet.open || confirmDlg.open) return;
    const result = C.runAuto(state, C.todayISO());
    if (!result.changed) return;
    save();
    if (result.created.length) {
      const total = result.created.reduce((sum, m) => sum + m.amount, 0);
      const ids = [...new Set(result.created.map((m) => m.goalId))];
      const where = ids.length === 1 ? '“' + state.goals.find((g) => g.id === ids[0]).name + '”' : ids.length + ' metas';
      toast('Ahorro automático: se pasaron ' + money(total) + ' a ' + where + '.');
    }
    render();
  }

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
    if (event.target.id === 'auto-on') setAutoEnabled(event.target.checked);
    if (event.target.name === 'stats-every') {
      if (event.target.value === 'other') {
        statsCustomOpen = true;
        render();
        refocus('#stats-days');
      } else {
        setStatsEvery(Number(event.target.value));
      }
    }
    if (event.target.name === 'auto-every') {
      if (event.target.value === 'other') {
        autoCustomOpen = true;
        render();
        refocus('#auto-days');
      } else {
        setAutoEvery(Number(event.target.value));
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyAuto();
  });
  setInterval(applyAuto, 10 * 60 * 1000);

  /* "Otro" solo queda abierto mientras se está escribiendo el número en esa pantalla. */
  function resetCustomPeriods() {
    autoCustomOpen = false;
    statsCustomOpen = false;
  }

  window.addEventListener('hashchange', () => { closeSheet(); resetCustomPeriods(); render(); });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawOgives, 150);
  });

  /* Mantiene sincronizadas otras pestañas abiertas para que una no sobrescriba a la otra. */
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    const result = load();
    if (result.state) {
      state = result.state;
      closeSheet();
      resetCustomPeriods();
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
  applyAuto();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
