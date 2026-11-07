/* Lógica pura de AV ahorros: sin acceso al DOM ni al almacenamiento.
   Los montos se guardan como enteros en centésimas para evitar errores de redondeo. */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const MAX_AMOUNT = 99999999999999;
  const MAX_NAME = 60;
  const MAX_NOTE = 120;
  const MAX_AUTO_DAYS = 365;
  const AUTO_NOTE = 'Ahorro automático';

  const CURRENCIES = [
    ['MXN', 'Peso mexicano'], ['USD', 'Dólar estadounidense'], ['EUR', 'Euro'],
    ['ARS', 'Peso argentino'], ['BOB', 'Boliviano'], ['CLP', 'Peso chileno'],
    ['COP', 'Peso colombiano'], ['CRC', 'Colón costarricense'], ['DOP', 'Peso dominicano'],
    ['GTQ', 'Quetzal'], ['HNL', 'Lempira'], ['PEN', 'Sol peruano'],
    ['PYG', 'Guaraní'], ['UYU', 'Peso uruguayo'],
  ];

  const DEFAULT_CATEGORIES = ['Vivienda', 'Comida', 'Transporte', 'Servicios', 'Salud', 'Ocio', 'Otros'];

  function newId() {
    const bytes = new Uint8Array(12);
    root.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function emptyState() {
    return {
      schema: SCHEMA,
      currency: 'MXN',
      onboarded: false,
      lastBackup: null,
      goals: [],
      moves: [],
      txs: [],
      categories: DEFAULT_CATEGORIES.map((name) => ({ id: newId(), name, budget: 0 })),
      auto: defaultAuto(),
    };
  }

  /* Ahorro automático: since = desde cuándo cuenta el dinero, next = próxima fecha de traspaso. */
  function defaultAuto() {
    return { enabled: false, everyDays: 7, since: null, next: null, splits: [] };
  }

  /* Acepta "1234", "1,234.50", "1.234,50" y "12,5". Devuelve centésimas, o null si no es válido. */
  function parseAmount(raw) {
    let s = String(raw == null ? '' : raw).trim().replace(/[\s$€]/g, '');
    if (!s) return null;
    s = s.replace(/[.,]$/, '');
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    let whole = s;
    let decimals = '';
    if (last >= 0) {
      const after = s.length - last - 1;
      if (after === 1 || after === 2) {
        whole = s.slice(0, last);
        decimals = s.slice(last + 1);
      } else if (after !== 3) {
        return null;
      }
    }
    if (whole !== '' && !/^\d+$/.test(whole)) {
      if (!/^\d{1,3}([.,])\d{3}(\1\d{3})*$/.test(whole)) return null;
      whole = whole.replace(/[.,]/g, '');
    }
    if (whole.length > 13) return null;
    const cents = Number(whole || '0') * 100 + Number(decimals.padEnd(2, '0') || '0');
    return cents <= MAX_AMOUNT ? cents : null;
  }

  function centsToInput(cents) {
    return Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function todayISO(now) {
    const d = now || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
  }

  function daysBetween(from, to) {
    const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((utc(to) - utc(from)) / 86400000);
  }

  function signed(move) { return move.type === 'in' ? move.amount : -move.amount; }

  function goalBalance(state, goalId) {
    return state.moves.reduce((sum, m) => (m.goalId === goalId ? sum + signed(m) : sum), 0);
  }

  function totalSaved(state) {
    return state.moves.reduce((sum, m) => sum + signed(m), 0);
  }

  function monthSummary(state, month) {
    let income = 0;
    let expense = 0;
    let saved = 0;
    state.txs.forEach((t) => {
      if (t.date.slice(0, 7) !== month) return;
      if (t.type === 'income') income += t.amount; else expense += t.amount;
    });
    state.moves.forEach((m) => {
      if (m.date.slice(0, 7) === month) saved += signed(m);
    });
    return { income, expense, saved, available: income - expense - saved };
  }

  function categorySpend(state, month, categoryId) {
    return state.txs.reduce((sum, t) => (
      t.type === 'expense' && t.date.slice(0, 7) === month && t.categoryId === categoryId ? sum + t.amount : sum
    ), 0);
  }

  function byDateDesc(a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  }

  function addDays(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }

  function activeGoals(state) {
    return state.goals.filter((g) => goalBalance(state, g.id) < g.target);
  }

  /* Dinero sin asignar entre dos fechas: ingresos menos gastos y menos lo que ya se pasó a metas.
     Como cuenta los aportes, lo que ya se pasó nunca se vuelve a pasar. */
  function autoPool(state, since, until) {
    let sum = 0;
    state.txs.forEach((t) => {
      if (t.date >= since && t.date <= until) sum += t.type === 'income' ? t.amount : -t.amount;
    });
    state.moves.forEach((m) => {
      if (m.date >= since && m.date <= until) sum -= signed(m);
    });
    return sum;
  }

  /* Metas que reciben el dinero y su porcentaje. Sin reparto elegido, se usa la única meta en curso.
     Las metas completas o borradas se saltan y su parte se reparte entre las demás. */
  function autoTargets(state) {
    const splits = state.auto.splits || [];
    if (splits.length) {
      return splits
        .map((s) => ({ goal: state.goals.find((g) => g.id === s.goalId), weight: s.pct }))
        .filter((t) => t.goal && goalBalance(state, t.goal.id) < t.goal.target);
    }
    const goals = activeGoals(state);
    return goals.length === 1 ? [{ goal: goals[0], weight: 100 }] : [];
  }

  /* Reparte un monto por porcentaje sin pasarse de lo que le falta a cada meta.
     Lo que una meta no puede recibir se reparte entre las otras; los centavos sobrantes van a las primeras. */
  function distribute(state, targets, pool) {
    const room = new Map(targets.map((t) => [t.goal.id, t.goal.target - goalBalance(state, t.goal.id)]));
    const given = new Map();
    let left = pool;
    let open = targets.filter((t) => room.get(t.goal.id) > 0);
    while (left > 0 && open.length) {
      const weight = open.reduce((sum, t) => sum + t.weight, 0);
      const shares = open.map((t) => Math.floor((left * t.weight) / weight));
      let rest = left - shares.reduce((a, b) => a + b, 0);
      for (let i = 0; rest > 0; i = (i + 1) % shares.length, rest -= 1) shares[i] += 1;
      let round = 0;
      open.forEach((t, i) => {
        const amount = Math.min(shares[i], room.get(t.goal.id));
        if (amount > 0) {
          given.set(t.goal.id, (given.get(t.goal.id) || 0) + amount);
          room.set(t.goal.id, room.get(t.goal.id) - amount);
          round += amount;
        }
      });
      left -= round;
      if (!round) break;
      open = open.filter((t) => room.get(t.goal.id) > 0);
    }
    return targets.filter((t) => given.get(t.goal.id) > 0).map((t) => ({ goal: t.goal, amount: given.get(t.goal.id) }));
  }

  /* Lo que se pasaría en una fecha y a qué metas. */
  function autoPreview(state, until) {
    const targets = autoTargets(state);
    const pool = autoPool(state, state.auto.since, until);
    return { targets, parts: targets.length && pool > 0 ? distribute(state, targets, pool) : [] };
  }

  /* Hace los traspasos pendientes hasta hoy, incluidos los de días en que la app estuvo cerrada.
     Si ese día no hay a qué meta pasar el dinero, no pasa nada y el dinero espera al siguiente. */
  function runAuto(state, today) {
    const auto = state.auto;
    const result = { created: [], skipped: 0, changed: false };
    if (!auto || !auto.enabled) return result;
    for (let i = 0; i < 1000 && auto.next <= today; i += 1) {
      const due = auto.next;
      const { targets, parts } = autoPreview(state, due);
      if (!targets.length) result.skipped += 1;
      parts.forEach((p) => {
        const move = { id: newId(), goalId: p.goal.id, type: 'in', amount: p.amount, date: due, note: AUTO_NOTE };
        state.moves.push(move);
        result.created.push(move);
      });
      auto.next = addDays(due, auto.everyDays);
      result.changed = true;
    }
    return result;
  }

  /* Deja los porcentajes en enteros que suman 100, conservando las proporciones.
     Cada meta elegida conserva al menos 1% para que nunca quede fuera del reparto. */
  function normalizeSplits(splits) {
    const list = splits.slice(0, 100);
    const total = list.reduce((sum, s) => sum + s.pct, 0);
    if (!total) return [];
    const scaled = list.map((s) => (s.pct * 100) / total);
    const out = list.map((s, i) => ({ goalId: s.goalId, pct: Math.max(1, Math.floor(scaled[i])) }));
    let diff = 100 - out.reduce((sum, s) => sum + s.pct, 0);
    const byFraction = scaled.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; diff > 0; k = (k + 1) % out.length, diff -= 1) out[byFraction[k].i].pct += 1;
    while (diff < 0) {
      const largest = out.reduce((best, s) => (s.pct > best.pct ? s : best));
      largest.pct -= 1;
      diff += 1;
    }
    return out;
  }

  function sanitizeAuto(raw, goalIds) {
    if (!raw || typeof raw !== 'object') return defaultAuto();
    const everyDays = Number.isSafeInteger(raw.everyDays) && raw.everyDays >= 1 && raw.everyDays <= MAX_AUTO_DAYS ? raw.everyDays : 7;
    const seen = new Set();
    const splits = (Array.isArray(raw.splits) ? raw.splits : []).slice(0, 100).filter((s) => {
      const ok = s && goalIds.has(s.goalId) && !seen.has(s.goalId) && Number.isSafeInteger(s.pct) && s.pct >= 1 && s.pct <= 100;
      if (ok) seen.add(s.goalId);
      return ok;
    }).map((s) => ({ goalId: s.goalId, pct: s.pct }));
    const clean = normalizeSplits(splits);
    if (raw.enabled === true && isDate(raw.since) && isDate(raw.next) && raw.next > raw.since) {
      return { enabled: true, everyDays, since: raw.since, next: raw.next, splits: clean };
    }
    return { enabled: false, everyDays, since: null, next: null, splits: clean };
  }

  /* Valida un respaldo sin confiar en su contenido y conserva solo los campos conocidos. */
  function sanitizeBackup(input) {
    const fail = (msg) => { throw new Error(msg); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('El archivo no es un respaldo de AV ahorros.');
    if (input.app !== 'alcancia') fail('El archivo no es un respaldo de AV ahorros.');
    if (input.schema !== SCHEMA) fail('Este respaldo es de una versión que esta app no reconoce.');
    if (!CURRENCIES.some(([code]) => code === input.currency)) fail('El respaldo tiene una moneda no válida.');
    ['goals', 'moves', 'txs', 'categories'].forEach((k) => {
      if (!Array.isArray(input[k])) fail('Al respaldo le faltan datos.');
    });

    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const amount = (v, min) => Number.isSafeInteger(v) && v >= min && v <= MAX_AMOUNT;
    const validId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
    const uniqueIds = (list) => new Set(list.map((x) => x.id)).size === list.length;

    const categories = input.categories.map((c) => {
      if (!c || !validId(c.id) || !text(c.name, MAX_NAME) || !amount(c.budget, 0)) fail('Hay una categoría no válida.');
      return { id: c.id, name: text(c.name, MAX_NAME), budget: c.budget };
    });
    const goals = input.goals.map((g) => {
      if (!g || !validId(g.id) || !text(g.name, MAX_NAME) || !amount(g.target, 1)) fail('Hay una meta no válida.');
      if (g.deadline != null && !isDate(g.deadline)) fail('Hay una meta con una fecha no válida.');
      if (!isDate(g.createdAt)) fail('Hay una meta con una fecha no válida.');
      return { id: g.id, name: text(g.name, MAX_NAME), target: g.target, deadline: g.deadline || null, createdAt: g.createdAt };
    });
    const goalIds = new Set(goals.map((g) => g.id));
    const categoryIds = new Set(categories.map((c) => c.id));
    const moves = input.moves.map((m) => {
      if (!m || !validId(m.id) || !goalIds.has(m.goalId) || (m.type !== 'in' && m.type !== 'out')
        || !amount(m.amount, 1) || !isDate(m.date)) fail('Hay un aporte o retiro no válido.');
      return { id: m.id, goalId: m.goalId, type: m.type, amount: m.amount, date: m.date, note: text(m.note, MAX_NOTE) };
    });
    const txs = input.txs.map((t) => {
      if (!t || !validId(t.id) || (t.type !== 'income' && t.type !== 'expense')
        || !amount(t.amount, 1) || !isDate(t.date)) fail('Hay un ingreso o gasto no válido.');
      const categoryId = t.type === 'expense' && categoryIds.has(t.categoryId) ? t.categoryId : null;
      return { id: t.id, type: t.type, amount: t.amount, categoryId, date: t.date, note: text(t.note, MAX_NOTE) };
    });
    if (![categories, goals, moves, txs].every(uniqueIds)) fail('El respaldo tiene registros duplicados.');

    const state = {
      schema: SCHEMA,
      currency: input.currency,
      onboarded: true,
      lastBackup: typeof input.lastBackup === 'string' && isDate(input.lastBackup) ? input.lastBackup : null,
      goals, moves, txs, categories,
      auto: sanitizeAuto(input.auto, goalIds),
    };
    if (goals.some((g) => goalBalance(state, g.id) < 0)) fail('El respaldo tiene una meta con saldo negativo.');
    return state;
  }

  const MAX_ESTIMATE_DAYS = 36500;

  /* Estadísticas de una meta a partir de todos sus aportes, incluidos los automáticos.
     Promedio = lo ahorrado neto (aportes menos retiros) entre el número de aportes.
     Frecuencia = días entre el primer y el último aporte, entre los espacios que hay entre ellos.
     Estimación = aportes que faltan al promedio, por la frecuencia, contados desde hoy. */
  function goalStats(state, goal, today) {
    const moves = state.moves.filter((m) => m.goalId === goal.id);
    const ins = moves.filter((m) => m.type === 'in').map((m) => m.date).sort();
    const balance = goalBalance(state, goal.id);
    const stats = {
      count: ins.length,
      balance,
      remaining: Math.max(0, goal.target - balance),
      average: null,
      everyDays: null,
      daysLeft: null,
      eta: null,
      onTime: null,
      reason: null,
    };
    if (!stats.remaining) { stats.reason = 'done'; return stats; }
    if (ins.length < 2) { stats.reason = 'few'; return stats; }
    stats.average = Math.floor(balance / ins.length);
    const span = daysBetween(ins[0], ins[ins.length - 1]);
    if (span > 0) stats.everyDays = span / (ins.length - 1);
    if (stats.average <= 0) { stats.reason = 'noProgress'; return stats; }
    if (!stats.everyDays) { stats.reason = 'sameDay'; return stats; }
    const days = Math.ceil(Math.ceil(stats.remaining / stats.average) * stats.everyDays);
    if (days > MAX_ESTIMATE_DAYS) { stats.reason = 'tooLong'; return stats; }
    stats.daysLeft = days;
    stats.eta = addDays(today, days);
    if (goal.deadline) stats.onTime = stats.eta <= goal.deadline;
    return stats;
  }

  root.AlcanciaCore = {
    SCHEMA, MAX_AMOUNT, MAX_NAME, MAX_NOTE, MAX_AUTO_DAYS, CURRENCIES, goalStats,
    newId, emptyState, parseAmount, centsToInput, todayISO, isDate, shiftMonth, daysBetween,
    signed, goalBalance, totalSaved, monthSummary, categorySpend, byDateDesc, sanitizeBackup,
    addDays, activeGoals, autoPool, autoTargets, distribute, autoPreview, runAuto, normalizeSplits,
  };
})(typeof window !== 'undefined' ? window : self);
