/* Lógica pura de AV ahorros: sin acceso al DOM ni al almacenamiento.
   Los montos se guardan como enteros en centésimas para evitar errores de redondeo. */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const MAX_AMOUNT = 99999999999999;
  const MAX_NAME = 60;
  const MAX_NOTE = 120;

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
    };
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
    };
    if (goals.some((g) => goalBalance(state, g.id) < 0)) fail('El respaldo tiene una meta con saldo negativo.');
    return state;
  }

  root.AlcanciaCore = {
    SCHEMA, MAX_AMOUNT, MAX_NAME, MAX_NOTE, CURRENCIES,
    newId, emptyState, parseAmount, centsToInput, todayISO, isDate, shiftMonth, daysBetween,
    signed, goalBalance, totalSaved, monthSummary, categorySpend, byDateDesc, sanitizeBackup,
  };
})(typeof window !== 'undefined' ? window : self);
