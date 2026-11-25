/* Punto Seguro — app.js
   Versión en JavaScript puro del proyecto Next.js + Payload.
   Sin servidor: usuarios, espacios e incidentes se guardan en localStorage
   y se sincronizan entre pestañas del mismo navegador. */
(() => {
  'use strict';

  /* ---------- Constantes ---------- */
  const KEY = 'ps:db', SESSION = 'ps:session';
  const TYPES = { fire: 'Incendio', earthquake: 'Sismo', flood: 'Inundación', gas: 'Fuga de gas', medical: 'Emergencia médica', other: 'Otra emergencia' };
  const STAGES = ['classification', 'notify', 'evacuation', 'count', 'assistance', 'search', 'damage', 'complete'];
  const STAGE_IDS = ['classification', 'notify', 'evacuation', 'count', 'injured', 'medical', 'missing', 'rescue', 'found', 'foundInjured', 'foundMedical', 'resume', 'safeZone', 'damage', 'complete', 'assistance', 'search'];
  const LABELS = {
    classification: 'Clasificar', notify: 'Alertar', evacuation: 'Evacuar', count: 'Recuento', injured: 'Heridos',
    medical: 'Asistencia médica', missing: 'Verificar faltantes', rescue: 'Activar rescate', found: 'Seguimiento',
    foundInjured: 'Evaluar hallazgo', foundMedical: 'Atención médica', resume: 'Autorización', safeZone: 'Zona segura',
    assistance: 'Asistencia', search: 'Búsqueda', damage: 'Evaluación', complete: 'Cierre',
  };
  const PHASE = {
    classification: 0, notify: 1, evacuation: 2, count: 3, injured: 4, medical: 4, missing: 5, rescue: 5, found: 5,
    foundInjured: 5, foundMedical: 5, assistance: 4, search: 5, resume: 6, safeZone: 6, damage: 6, complete: 7,
  };
  const ROLES = [['teacher', 'Docente'], ['health', 'Profesional de salud'], ['director', 'Directivo'], ['security', 'Guarda de seguridad'], ['administration', 'Administración'], ['other', 'Otro responsable']];
  const SPACE_TYPES = [['school', 'Escuela'], ['university', 'Universidad'], ['hospital', 'Hospital o clínica'], ['residential', 'Conjunto residencial'], ['business', 'Empresa u oficina'], ['other', 'Otro espacio']];

  /* ---------- Utilidades ---------- */
  const root = document.getElementById('root');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const missingOf = (c) => Math.max(0, c.expected - c.safe - c.injured);
  async function hash(text) {
    const data = 'ps:' + text;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return btoa(unescape(encodeURIComponent(data)));
  }

  /* ---------- Base de datos local ---------- */
  const blank = () => ({ users: [], spaces: [], incidents: [], updates: [], files: [] });
  const load = () => { try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return blank(); } };
  let db = load();
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch { S.toast = 'No se pudo guardar: el almacenamiento del navegador está lleno.'; }
  };

  const S = { mode: 'login', join: false, view: '', activeId: null, creating: false, draft: { type: 'fire', location: '', zone: '' }, toast: '', online: navigator.onLine, listFile: null };
  let toastTimer;
  const flash = (msg) => {
    S.toast = msg; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = ''; render(); }, 4500);
  };

  const me = () => db.users.find((u) => u.id === localStorage.getItem(SESSION));
  const mySpace = () => { const u = me(); return u && db.spaces.find((s) => s.id === u.spaceId); };
  const myIncidents = () => { const u = me(); return db.incidents.filter((i) => u && i.spaceId === u.spaceId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); };
  const incidentById = (id) => myIncidents().find((i) => i.id === id);
  const firstActive = () => (myIncidents().find((i) => i.status === 'active') || {}).id || null;

  /* ---------- Operaciones (equivalen a las server actions) ---------- */
  function record(incidentId, action, detail) {
    const u = me();
    db.updates.push({ id: uid(), incidentId, spaceId: u.spaceId, userId: u.id, action, detail, at: new Date().toISOString() });
  }

  function createIncident({ type, location, zone }) {
    const u = me(); location = location.trim().slice(0, 200);
    if (!u || !TYPES[type] || !location) return null;
    const title = `${type === 'fire' ? 'Incendio' : 'Emergencia'} · ${location.slice(0, 120)}`;
    const inc = {
      id: uid(), title, emergencyType: type, location, zone: zone.trim().slice(0, 120), status: 'active', stage: 'classification',
      startedAt: new Date().toISOString(), spaceId: u.spaceId, createdBy: u.id,
      counts: { expected: 0, safe: 0, injured: 0, missing: 0 }, checks: {},
    };
    db.incidents.push(inc); record(inc.id, 'Emergencia activada', title); persist();
    return inc;
  }

  function patchIncident(id, p) {
    const inc = db.incidents.find((i) => i.id === id); if (!inc) return;
    if (p.stage && STAGE_IDS.includes(p.stage)) inc.stage = p.stage;
    if (p.status && ['active', 'resolved', 'cancelled'].includes(p.status)) {
      inc.status = p.status;
      if (p.status !== 'active') inc.endedAt = new Date().toISOString();
    }
    if (['A', 'B', 'C'].includes(p.fireClass)) inc.fireClass = p.fireClass;
    if (p.authorityName !== undefined) inc.authorityName = String(p.authorityName).slice(0, 160);
    if (p.notes !== undefined) inc.notes = String(p.notes).slice(0, 2000);
    if (p.counts) {
      const expected = num(p.counts.expected), safe = Math.min(expected, num(p.counts.safe));
      const injured = Math.min(expected - safe, num(p.counts.injured));
      inc.counts = { expected, safe, injured, missing: Math.max(0, expected - safe - injured) };
    }
    if (p.checks) inc.checks = { ...inc.checks, ...p.checks };
    record(id, p.status === 'cancelled' ? 'Emergencia cancelada' : 'Información actualizada', p.stage ? `Fase: ${p.stage}` : 'Recuento o verificación');
    persist();
  }

  function save(patch, msg = 'Cambio guardado') {
    if (!S.activeId) return;
    patchIncident(S.activeId, patch);
    flash(msg); render();
  }

  async function raiseAlarm(inc) {
    try {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Punto Seguro', { body: inc.title || 'Protocolo de emergencia activo' });
    } catch { /* sin notificaciones */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880; osc.connect(gain).connect(ctx.destination); osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.4); osc.stop(ctx.currentTime + 1.4);
    } catch { /* sin audio */ }
    flash('Alarma local y notificación activadas'); render();
  }

  /* ---------- Autenticación ---------- */
  const text = (d, k, max = 200) => String(d[k] || '').trim().slice(0, max);
  async function register(d) {
    const email = text(d, 'email').toLowerCase(), password = text(d, 'password', 100), name = text(d, 'name');
    const phone = text(d, 'phone', 30), role = text(d, 'role', 30);
    if (!email || password.length < 8 || !name || !phone || !role) return 'Completa los campos. La contraseña debe tener al menos 8 caracteres.';
    if (db.users.some((u) => u.email === email)) return 'No fue posible crear la cuenta. Verifica que el correo no esté registrado.';
    let space;
    if (S.join) {
      const code = text(d, 'joinCode', 12).toUpperCase();
      space = db.spaces.find((s) => s.joinCode === code);
      if (!space) return 'El código del espacio no existe.';
    } else {
      const type = text(d, 'spaceType', 30), spaceName = text(d, 'spaceName'), address = text(d, 'address');
      if (!type || !spaceName || !address) return 'Completa los datos del espacio.';
      space = { id: uid(), name: spaceName, type, address, joinCode: Math.random().toString(36).slice(2, 8).toUpperCase() };
      db.spaces.push(space);
    }
    const user = { id: uid(), email, passwordHash: await hash(password), name, phone, role, spaceId: space.id };
    db.users.push(user); persist();
    startSession(user);
    return '';
  }

  async function login(d) {
    const email = text(d, 'email').toLowerCase(), passwordHash = await hash(text(d, 'password', 100));
    const user = db.users.find((u) => u.email === email && u.passwordHash === passwordHash);
    if (!user) return 'Correo o contraseña incorrectos.';
    startSession(user);
    return '';
  }

  function startSession(user) {
    localStorage.setItem(SESSION, user.id);
    S.activeId = firstActive(); S.creating = false;
    render();
  }

  /* ---------- Plantillas ---------- */
  const brand = (dark) => `<div class="brand${dark ? ' dark' : ''}"><span class="brand-mark">P</span><div><strong>Punto Seguro</strong><small>Emergencias Colombia</small></div></div>`;
  const field = (label, name, type, ph) => `<label class="block"><span class="field-label">${label}</span><input class="input" name="${name}" type="${type}" placeholder="${ph}"></label>`;
  const select = (label, name, ph, opts) => `<label class="block"><span class="field-label">${label}</span><select name="${name}" class="input"><option value="">${ph}</option>${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;
  const submit = (label) => `<button class="btn btn-primary btn-block submit" type="submit">${label}</button>`;

  function authHTML() {
    const isLogin = S.mode === 'login';
    const form = isLogin
      ? `<form class="form" data-form="login" novalidate>${field('Correo electrónico', 'email', 'email', 'nombre@organizacion.com')}${field('Contraseña', 'password', 'password', 'Tu contraseña')}${submit('Ingresar a Punto Seguro')}</form>`
      : `<form class="form" data-form="register" novalidate>
          <div class="grid-2">${field('Nombre completo', 'name', 'text', 'Nombre del responsable')}${field('Número de celular', 'phone', 'tel', '+57 300 000 0000')}</div>
          ${select('Tu función', 'role', 'Selecciona una opción', ROLES)}
          <div class="notice"><span>¿Tu organización ya tiene un espacio?</span><button type="button" class="link-btn" data-action="toggle-join">Usar código</button></div>
          <div id="join-block" hidden>${field('Código del espacio', 'joinCode', 'text', 'Ej. A3P7XZ')}</div>
          <div id="space-block" class="form" style="margin-top:0">
            ${select('Tipo de espacio', 'spaceType', 'Selecciona el lugar', SPACE_TYPES)}
            <div class="grid-2">${field('Nombre del espacio', 'spaceName', 'text', 'Institución o sede')}${field('Dirección', 'address', 'text', 'Ciudad y dirección')}</div>
          </div>
          <div class="grid-2">${field('Correo electrónico', 'email', 'email', 'correo@ejemplo.com')}${field('Contraseña', 'password', 'password', 'Mínimo 8 caracteres')}</div>
          ${submit('Crear cuenta y continuar')}</form>`;
    return `<main class="auth"><div class="auth-card">
      <section class="auth-hero"><div class="auth-ring"></div>${brand()}
        <div class="rel"><p class="eyebrow">Respuesta coordinada</p><h1>Cada persona cuenta.</h1><p class="lead">Organiza la evacuación, sincroniza el recuento y guía a tu equipo durante una emergencia, incluso sin conexión.</p></div>
        <div class="features">${['Modo offline', 'Datos en vivo', 'Alarma local'].map((t) => `<div>${t}</div>`).join('')}</div>
      </section>
      <section class="auth-form"><div class="auth-form-inner">
        <div class="auth-mobile-brand">${brand(true)}</div>
        <p class="eyebrow">${isLogin ? 'Acceso seguro' : 'Configura tu espacio'}</p>
        <h2>${isLogin ? 'Bienvenido de nuevo' : 'Crea tu cuenta operativa'}</h2>
        <p class="lead">${isLogin ? 'Ingresa para continuar con tu equipo.' : 'El primer usuario crea el espacio; los demás se unen con su código.'}</p>
        <div class="tabs">${['login', 'register'].map((m) => `<button type="button" class="${S.mode === m ? 'on' : ''}" data-action="mode" data-mode="${m}">${m === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</button>`).join('')}</div>
        ${form}
        <p role="alert" class="error" id="auth-error" hidden></p>
        <p class="legal">Al continuar confirmas que eres una persona autorizada para coordinar emergencias en este espacio.</p>
      </div></section></div></main>`;
  }

  const header = (u, compact) => `<header class="app-header"><div class="container"><div class="brand"><span class="brand-mark">P</span><div><strong>SafeLine</strong>${compact ? '' : '<small>Colombia</small>'}</div></div>
    <div class="hdr-right"><span class="hide-sm ${S.online ? 'online' : 'offline'}">● ${S.online ? 'En línea' : 'Sin conexión'}</span><span class="hide-md">${esc(u.name)}</span>
    <button class="chip-btn" data-action="${compact ? 'back' : 'logout'}">${compact ? 'Salir' : 'Cerrar sesión'}</button></div></div></header>`;

  const card = (i) => {
    const c = i.counts || { expected: 0, safe: 0, injured: 0 };
    const time = new Date(i.startedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    return `<button class="incident" data-action="open" data-id="${i.id}"><div class="row"><span class="tag">${TYPES[i.emergencyType]}</span><span class="stage-name">${LABELS[i.stage]}</span></div>
      <h3>${esc(i.location)}</h3><p class="meta">${esc(i.zone || 'Zona general')} · ${time}</p>
      <div class="foot"><span><strong>${c.safe}</strong> a salvo</span><span><strong class="red">${missingOf(c)}</strong> faltantes</span></div></button>`;
  };

  function modalHTML() {
    const d = S.draft;
    return `<div class="overlay"><div class="modal">
      <div class="row" style="align-items:flex-start"><div><p class="eyebrow">Nueva alerta</p><h2>Activar una emergencia</h2></div><button class="x" data-action="close">×</button></div>
      <div class="types">${Object.entries(TYPES).map(([v, l]) => `<button class="type${d.type === v ? ' on' : ''}" data-action="type" data-type="${v}">${l}</button>`).join('')}</div>
      <div class="grid-2"><label><span class="field-label">Ubicación exacta</span><input class="input" data-draft="location" value="${esc(d.location)}" placeholder="Dirección o sede"></label>
      <label><span class="field-label">Edificio, piso o zona</span><input class="input" data-draft="zone" value="${esc(d.zone)}" placeholder="Ej. Bloque B, piso 2"></label></div>
      <div class="modal-actions"><button class="btn btn-outline" data-action="close">Volver</button><button class="btn btn-primary" data-action="create"${d.location.trim() ? '' : ' disabled'}>Activar y enviar alertas</button></div></div></div>`;
  }

  function dashHTML(u, sp) {
    const all = myIncidents(), active = all.filter((i) => i.status === 'active'), hist = all.filter((i) => i.status !== 'active');
    return `${header(u, false)}<main class="container page">
      <div class="page-head"><div><p class="eyebrow">Centro de control</p><h1>Hola, ${esc(u.name.split(' ')[0])}</h1><p class="sub">${esc(sp.name)} · ${esc(sp.address)}</p></div>
        <button class="btn btn-primary btn-activate" data-action="new">+ Activar emergencia</button></div>
      <section class="metrics"><div class="metric orange"><strong>${active.length}</strong><span>Emergencias activas</span></div><div class="metric"><strong>${all.length}</strong><span>Registros totales</span></div>
        <div class="metric code"><span>Código para tu equipo</span><strong>${esc(sp.joinCode)}</strong></div></section>
      <section class="section"><h2>En curso</h2><div class="cards">${active.map(card).join('') || '<div class="empty"><strong>No hay emergencias activas</strong><p>Activa una emergencia para iniciar el protocolo compartido.</p></div>'}</div></section>
      <section class="section"><h2>Historial</h2><div class="history">${hist.length ? hist.map((i) => `<div><div><strong>${esc(i.title)}</strong><span class="meta">${new Date(i.startedAt).toLocaleString('es-CO')}</span></div><span class="pill">${i.status === 'cancelled' ? 'Cancelada' : 'Finalizada'}</span></div>`).join('') : '<p>Aún no hay incidentes cerrados.</p>'}</div></section>
    </main>${S.creating ? modalHTML() : ''}`;
  }

  /* --- Contenido de cada fase del protocolo --- */
  const T = (title, copy) => `<h2 class="stage-title">${title}</h2><p class="copy">${copy}</p>`;
  const patchAttr = (p) => `data-action="patch" data-patch="${esc(JSON.stringify(p))}"`;
  const next = (p, disabled, label = 'Continuar al siguiente paso') => `<button class="btn btn-primary btn-block next" ${patchAttr(p)}${disabled ? ' disabled' : ''}>${label} →</button>`;
  const btn = (p, cls, label) => `<button class="btn ${cls}" ${patchAttr(p)}>${label}</button>`;
  const call = (label) => `<a class="btn btn-danger" href="tel:119">${label}</a>`;
  const check = (label, key, on) => `<label class="check"><input type="checkbox" data-check="${key}"${on ? ' checked' : ''}>${label}</label>`;
  const mini = (v, l, alert) => `<div class="mini${alert ? ' alert' : ''}"><strong>${v}</strong><span>${l}</span></div>`;
  const countInput = (label, key, v) => `<label><span class="field-label">${label}</span><input class="input big" type="number" min="0" value="${v}" data-count="${key}"></label>`;

  function stageHTML(inc, c, miss) {
    const k = inc.checks || {};
    let s = inc.stage;
    if (s === 'injured') s = c.injured > 0 ? 'medical' : miss > 0 ? 'rescue' : 'resume';
    else if (s === 'missing') s = miss > 0 ? 'rescue' : 'resume';
    const fire = inc.emergencyType === 'fire';
    switch (s) {
      case 'classification':
        return T('Identifica la emergencia', 'Confirma el tipo de evento desde un lugar seguro. No te expongas para obtener información.')
          + (fire ? `<div class="fire-classes">${[['A', 'Sólidos'], ['B', 'Líquidos'], ['C', 'Eléctrico']].map(([v, l]) => `<button class="fire${inc.fireClass === v ? ' on' : ''}" ${patchAttr({ fireClass: v })}><strong>${v}</strong><span>${l}</span></button>`).join('')}</div>` : '')
          + next({ stage: 'notify' }, fire && !inc.fireClass);
      case 'notify':
        return T('Alerta a las autoridades', 'Llama al 119 en Colombia. Indica el tipo de emergencia, dirección, zona afectada y riesgos conocidos.')
          + `<div class="callout warn">Ubicación: ${esc(inc.location)}${inc.zone ? ' · ' + esc(inc.zone) : ''}</div>`
          + check('Autoridades notificadas', 'authoritiesNotified', k.authoritiesNotified) + next({ stage: 'evacuation' }, !k.authoritiesNotified);
      case 'evacuation':
        return T('Ejecuta la evacuación', 'Guía a las personas por rutas seguras hasta el punto de encuentro. No uses ascensores ni regreses por objetos.')
          + check('Alarma general activada', 'alarmActivated', k.alarmActivated) + check('Rutas de evacuación despejadas', 'routesCleared', k.routesCleared)
          + check('Personas reunidas en el punto de encuentro', 'meetingPoint', k.meetingPoint)
          + next({ stage: 'count' }, !(k.alarmActivated && k.routesCleared && k.meetingPoint));
      case 'count':
        return T('Actualiza el recuento', 'Todos los responsables del espacio pueden editar estas cantidades. Los cambios se comparten automáticamente.')
          + `<div class="counts">${countInput('Registradas', 'expected', c.expected)}${countInput('Desaparecidas', 'missing', miss)}${countInput('Heridas', 'injured', c.injured)}</div>`
          + `<button class="btn btn-primary btn-block next" data-action="count-next">Continuar al siguiente paso →</button>`;
      case 'medical': case 'assistance':
        return T('Avisa a servicios médicos', `Comunica que hay ${c.injured} persona(s) herida(s). Aplica primeros auxilios solo si estás capacitado.`)
          + '<div class="callout">No muevas a una persona herida salvo que exista peligro inmediato.</div>'
          + `<div class="choices">${call('Llamar al 119')}${btn({ stage: miss > 0 ? 'rescue' : 'resume' }, 'btn-outline', 'Asistencia solicitada →')}</div>`;
      case 'rescue': case 'search':
        return T('Activa el protocolo de búsqueda', `Hay ${miss} persona(s) desaparecida(s). Informa a las autoridades la última ubicación conocida y los posibles riesgos. No ingreses al edificio.`)
          + '<div class="callout warn">Mantén despejados los accesos y entrega el listado a los equipos de rescate.</div>'
          + `<div class="choices">${call('Alertar al 119')}${btn({ stage: 'found' }, 'btn-outline', 'Autoridades avisadas →')}</div>`;
      case 'found':
        return T('¿Se encontraron las personas?', 'Mantén el protocolo activo y sigue únicamente las indicaciones de los equipos de rescate.')
          + `<div class="choices">${btn({ stage: 'foundInjured' }, 'btn-primary', 'Sí, fueron localizadas')}${btn({ stage: 'found' }, 'btn-outline', 'No, continuar búsqueda')}</div>`;
      case 'foundInjured':
        return T('¿Las personas encontradas están heridas?', 'Deja la valoración y el traslado en manos del personal de rescate y sanitario.')
          + `<div class="choices">${btn({ stage: 'foundMedical' }, 'btn-primary', 'Sí, hay heridas')}${btn({ stage: 'resume' }, 'btn-outline', 'No, están a salvo')}</div>`;
      case 'foundMedical':
        return T('Solicita personal médico', 'Informa de inmediato a los servicios médicos y facilita un acceso seguro a las personas rescatadas.')
          + `<div class="choices">${call('Llamar al 119')}${btn({ stage: 'resume' }, 'btn-outline', 'Personal avisado →')}</div>`;
      case 'resume':
        return T('¿Se pueden retomar las actividades?', 'Solo se puede volver cuando bomberos, Policía o la autoridad responsable confirmen que la zona es segura.')
          + '<div class="callout">No tomes esta decisión sin autorización oficial.</div>'
          + `<div class="choices">${btn({ stage: 'damage' }, 'btn-primary', 'Sí, fue autorizado')}${btn({ stage: 'safeZone' }, 'btn-outline', 'No, mantener evacuación')}</div>`;
      case 'safeZone':
        return T('Dirige a todos a una zona segura', 'Envía a las personas a sus hogares o a una zona segura designada y mantén libres los accesos de emergencia.')
          + next({ stage: 'damage' }, false, 'Personas reubicadas');
      case 'damage':
        return T('Evalúa daños y autorización', 'Después de controlar la emergencia, registra las estructuras afectadas sin acceder a zonas inestables.')
          + `<div class="fields"><label><span class="field-label">Autoridad responsable</span><input class="input" data-field="authorityName" value="${esc(inc.authorityName)}" placeholder="Nombre y entidad"></label>`
          + `<label><span class="field-label">Daños u observaciones</span><textarea class="input" data-field="notes" placeholder="Estructuras, accesos, electricidad, humo o agua…">${esc(inc.notes)}</textarea></label></div>`
          + next({ stage: 'complete' }, !inc.authorityName, 'Finalizar evaluación');
      default:
        return T('Finaliza el protocolo', 'Revisa el recuento y conserva el registro para el informe. Finalizar no elimina los datos ni el historial.')
          + `<div class="minis4">${mini(c.expected, 'Total')}${mini(c.safe, 'A salvo')}${mini(c.injured, 'Heridas')}${mini(miss, 'Faltantes', miss > 0)}</div>`
          + `<button class="btn btn-dark btn-block next" ${patchAttr({ status: 'resolved' })}>Cerrar emergencia y guardar informe</button>`;
    }
  }

  function protocolHTML(u, sp, inc) {
    const idx = PHASE[inc.stage] ?? 0;
    const c = inc.counts || { expected: 0, safe: 0, injured: 0, missing: 0 }, miss = missingOf(c);
    const files = db.files.filter((f) => f.incidentId === inc.id);
    const upload = `<div class="upload"><label>Adjuntar lista de personas <small>(CSV, TXT, PDF o XLSX)</small><input type="file" id="list-file" accept=".csv,.txt,.pdf,.xlsx"></label>
      ${S.listFile ? '<button class="btn btn-dark btn-sm up-btn" data-action="save-list">Guardar lista</button>' : ''}
      ${files.length ? `<ul class="files">${files.map((f) => `<li>${esc(f.name)} · ${Math.max(1, Math.ceil(f.size / 1024))} KB</li>`).join('')}</ul>` : ''}</div>`;
    return `${header(u, true)}
      <div class="topbar"><div class="container"><div><button class="back" data-action="back">← Centro de control</button><h1>${esc(inc.title)}</h1></div>
        <div class="actions"><button class="btn btn-outline btn-sm" data-action="alarm">Activar alarma local</button><a class="btn btn-danger btn-sm" href="tel:119">Llamar al 119</a><button class="btn btn-dark btn-sm" data-action="cancel">Cancelar emergencia</button></div></div></div>
      <main class="container protocol">
        <aside class="progress"><p>Progreso</p>${STAGES.map((s, i) => `<div class="step${i < idx ? ' done' : i === idx ? ' now' : ''}"><i>${i < idx ? '✓' : i + 1}</i>${LABELS[s]}</div>`).join('')}</aside>
        <section class="panel"><p class="eyebrow">Paso ${idx + 1} de ${STAGES.length}</p>${stageHTML(inc, c, miss)}${inc.stage === 'count' ? upload : ''}</section>
        <aside class="side"><div class="box"><h2>Recuento en vivo</h2><div class="minis">${mini(c.expected, 'Registradas')}${mini(c.safe, 'A salvo')}${mini(c.injured, 'Heridas')}${mini(miss, 'Faltantes', miss > 0)}</div>
          <p class="live">Se actualiza en todas las pestañas abiertas de ${esc(sp.name)} en este navegador.</p></div>
          <div class="status${S.online ? '' : ' off'}">${S.online ? '● Conectado · cambios en vivo' : '● Sin conexión · guardando localmente'}</div></aside>
      </main>`;
  }

  /* ---------- Render (con actualización incremental del DOM) ---------- */
  function morph(from, to) {
    for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
    for (const a of [...to.attributes]) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    if (from.tagName === 'INPUT') {
      if (from !== document.activeElement && from.type !== 'file') { if (from.type === 'checkbox') from.checked = to.checked; else from.value = to.value; }
      return;
    }
    if (from.tagName === 'TEXTAREA') { if (from !== document.activeElement) from.value = to.value; return; }
    morphChildren(from, to);
  }
  function morphChildren(from, to) {
    const t = [...to.childNodes];
    t.forEach((tn, i) => {
      const fn = from.childNodes[i];
      if (!fn) from.appendChild(tn.cloneNode(true));
      else if (fn.nodeType !== tn.nodeType || (fn.nodeType === 1 && fn.tagName !== tn.tagName)) from.replaceChild(tn.cloneNode(true), fn);
      else if (fn.nodeType === 3) { if (fn.nodeValue !== tn.nodeValue) fn.nodeValue = tn.nodeValue; }
      else morph(fn, tn);
    });
    while (from.childNodes.length > t.length) from.removeChild(from.lastChild);
  }

  function render() {
    const u = me();
    let view, html;
    if (!u) { view = 'auth-' + S.mode; if (view === S.view) return; html = authHTML(); }
    else {
      const inc = S.activeId && incidentById(S.activeId);
      if (inc && inc.status === 'active') { view = 'protocol'; html = protocolHTML(u, mySpace(), inc); }
      else { view = 'dash'; html = dashHTML(u, mySpace()); }
    }
    if (S.toast) html += `<div class="toast" role="status">${esc(S.toast)}</div>`;
    if (view !== S.view) { root.innerHTML = html; S.view = view; window.scrollTo(0, 0); }
    else { const tmp = document.createElement('div'); tmp.innerHTML = html; morphChildren(root, tmp); }
  }

  /* ---------- Eventos ---------- */
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const inc = S.activeId && incidentById(S.activeId);
    switch (el.dataset.action) {
      case 'mode': S.mode = el.dataset.mode; S.join = false; render(); break;
      case 'toggle-join':
        S.join = !S.join;
        document.getElementById('join-block').hidden = !S.join; document.getElementById('space-block').hidden = S.join;
        el.textContent = S.join ? 'Crear nuevo' : 'Usar código'; break;
      case 'logout': localStorage.removeItem(SESSION); S.activeId = null; S.creating = false; render(); break;
      case 'back': S.activeId = null; render(); break;
      case 'open': S.activeId = el.dataset.id; render(); break;
      case 'new': S.draft = { type: 'fire', location: '', zone: '' }; S.creating = true; render(); break;
      case 'close': S.creating = false; render(); break;
      case 'type': S.draft.type = el.dataset.type; render(); break;
      case 'create': {
        const created = createIncident(S.draft);
        if (!created) { flash('Revisa los datos de la emergencia.'); render(); break; }
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Emergencia activada', { body: created.title });
        S.creating = false; S.activeId = created.id; flash('Emergencia activada. Las alertas fueron enviadas.'); render(); break;
      }
      case 'alarm': if (inc) raiseAlarm(inc); break;
      case 'cancel': if (confirm('¿Confirmas que deseas cancelar esta emergencia?')) save({ status: 'cancelled' }, 'Emergencia cancelada'); break;
      case 'patch': save(JSON.parse(el.dataset.patch)); break;
      case 'count-next': if (inc) { const c = inc.counts || { expected: 0, safe: 0, injured: 0 }; save({ stage: c.injured > 0 ? 'medical' : missingOf(c) > 0 ? 'rescue' : 'resume' }); } break;
      case 'save-list': {
        const f = S.listFile, u = me();
        if (!f || !u) break;
        if (f.size > 8e6) { flash('Selecciona un archivo de máximo 8 MB.'); render(); break; }
        db.files.push({ id: uid(), incidentId: S.activeId, spaceId: u.spaceId, name: f.name, size: f.size, type: f.type, at: new Date().toISOString() });
        persist(); S.listFile = null; const input = document.getElementById('list-file'); if (input) input.value = '';
        flash('Lista registrada: ' + f.name); render(); break;
      }
    }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target, btn = form.querySelector('[type=submit]'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Procesando…';
    const data = Object.fromEntries(new FormData(form));
    const error = form.dataset.form === 'login' ? await login(data) : await register(data);
    if (error) {
      const box = document.getElementById('auth-error');
      if (box) { box.textContent = error; box.hidden = false; }
      btn.disabled = false; btn.textContent = label;
    }
  });

  root.addEventListener('input', (e) => {
    const key = e.target.dataset && e.target.dataset.draft; if (!key) return;
    S.draft[key] = e.target.value;
    const create = root.querySelector('[data-action=create]'); if (create) create.disabled = !S.draft.location.trim();
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.check) save({ checks: { [t.dataset.check]: t.checked } });
    else if (t.id === 'list-file') { S.listFile = t.files[0] || null; render(); }
  });

  root.addEventListener('focusout', (e) => {
    const t = e.target, inc = S.activeId && incidentById(S.activeId); if (!inc) return;
    if (t.dataset.count) {
      const v = num(t.value), c = inc.counts || { expected: 0, safe: 0, injured: 0 }, miss = missingOf(c), k = t.dataset.count;
      if (v === { expected: c.expected, missing: miss, injured: c.injured }[k]) return;
      let counts;
      if (k === 'expected') counts = { expected: v, injured: c.injured, safe: Math.max(0, v - miss - c.injured) };
      else if (k === 'missing') { const d = Math.min(v, Math.max(0, c.expected - c.injured)); counts = { expected: c.expected, injured: c.injured, safe: Math.max(0, c.expected - d - c.injured) }; }
      else { const inj = Math.min(v, Math.max(0, c.expected - miss)); counts = { expected: c.expected, injured: inj, safe: Math.max(0, c.expected - miss - inj) }; }
      save({ counts });
    } else if (t.dataset.field && (inc[t.dataset.field] || '') !== t.value) save({ [t.dataset.field]: t.value });
  });

  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === SESSION) { db = load(); render(); } });
  window.addEventListener('online', () => { S.online = true; render(); });
  window.addEventListener('offline', () => { S.online = false; render(); });

  /* ---------- Inicio ---------- */
  if (me()) S.activeId = firstActive();
  render();
})();
