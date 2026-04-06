// ─────────────────────────────────────────────────────────────
//  Outreach CRM v2 — app.js
//  Set your Supabase credentials below before deploying
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://fiztvuplgrtmfynjvulv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpenR2dXBsZ3J0bWZ5bmp2dWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5MDY1OTIsImV4cCI6MjA5MDQ4MjU5Mn0.T1v3y5hBYXRlAi9D_bsfZwsS8HtF_NPbqczSy0WLiyg';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── STATE ────────────────────────────────────────────────────
let currentUser = null;
let currentProfile = null;
let allLeads = [];
let allUsers = [];
let currentScript = null;
let bookingLink = '';        // loaded from settings table
let pendingImport = null;      // staged CSV leads waiting for confirmation
let todayProgress = { calls_done: 0, goal: 20 };
let navStack = [];
let currentPage = 'dashboard';

// ─── BOOT ─────────────────────────────────────────────────────
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await boot(session.user);
  sb.auth.onAuthStateChange((_e, session) => {
    if (session) boot(session.user); else showLogin();
  });
})();

async function boot(user) {
  currentUser = user;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;
  showApp();
  buildNav();
  buildTopbar();
  await Promise.all([
    loadLeads(),
    loadProgress(),
    isAdmin() ? loadUsers() : Promise.resolve(),
    loadScript(),
    loadSettings(),
  ]);
  // Restore saved page (don't restore admin pages for reps)
  const saved = localStorage.getItem('crm_page') || 'dashboard';
  navStack = [];
  navTo(saved, true);
  restoreScriptFloat();
}

// ─── AUTH ─────────────────────────────────────────────────────
async function signIn() {
  const email = q('#login-email').value.trim();
  const pw = q('#login-pw').value;
  const err = q('#login-err');
  err.style.display = 'none';
  const { error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) { err.textContent = error.message; err.style.display = 'block'; }
}

async function signOut() {
  localStorage.removeItem('crm_page');
  await sb.auth.signOut();
  showLogin();
}

async function inviteRep() {
  const email = q('#invite-email').value.trim();
  const name = q('#invite-name').value.trim();
  if (!email) { toast('Email required'); return; }
  const { error } = await sb.auth.signUp({
    email,
    password: Math.random().toString(36).slice(2) + 'Aa1!',
    options: { data: { full_name: name, role: 'rep' } }
  });
  if (error) { toast('❌ ' + error.message); return; }
  closeInviteModal();
  toast('✓ Invite sent to ' + email);
  await loadUsers(); renderUsers();
}

// ─── UI HELPERS ───────────────────────────────────────────────
const q = sel => document.querySelector(sel);
const qa = sel => document.querySelectorAll(sel);
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = d => { if (!d) return '—'; const [y, m, day] = d.split('-'); return `${m}/${day}/${y}`; };
const isAdmin = () => currentProfile?.role === 'admin';

function relativeTime(ts) {
  if (!ts) return '—';
  const diffMs = Date.now() - new Date(ts).getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return fmtDate(ts.slice(0, 10));
}

function showLogin() {
  q('#login-screen').style.display = 'flex';
  q('#app').classList.remove('show');
  q('#mobile-nav').style.display = 'none';
  q('#fab-script').style.display = 'none';
}
function showApp() {
  q('#login-screen').style.display = 'none';
  q('#app').classList.add('show');
}

function toast(msg, dur = 2600) {
  const t = q('#toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

// ─── NAV ──────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { id: 'leads', label: 'Leads', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { id: 'script', label: 'Script', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8' },
  { id: 'users', label: 'Users', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75', admin: true },
];

function buildNav() {
  q('#user-email-label').textContent = currentUser.email;
  q('#user-role-label').textContent = currentProfile?.role || 'rep';
  q('#nav').innerHTML = NAV_ITEMS
    .filter(n => !n.admin || isAdmin())
    .map(n => `<button class="nav-item" data-page="${n.id}" onclick="navTo('${n.id}')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${n.icon}"/></svg>
      ${n.label}</button>`).join('');
}

function buildTopbar() {
  q('#leads-actions').innerHTML = isAdmin()
    ? `<button class="btn btn-secondary btn-sm" onclick="openCsvModal()">Upload CSV</button>
       <button class="btn btn-primary btn-sm" onclick="openLeadModal(null)">+ Add Lead</button>`
    : `<button class="btn btn-primary btn-sm" onclick="openLeadModal(null)">+ Add Lead</button>`;
  q('#dash-actions').innerHTML = isAdmin()
    ? `<button class="btn btn-secondary btn-sm" onclick="navTo('users')">Users</button>` : '';
  q('#script-actions').innerHTML = isAdmin()
    ? `<button class="btn btn-secondary btn-sm" onclick="openScriptEditModal()">Edit Script</button>` : '';
}

function navTo(page, replace = false) {
  if (page === 'users' && !isAdmin()) page = 'dashboard';
  if (!replace && currentPage !== page) navStack.push(currentPage);
  currentPage = page;
  localStorage.setItem('crm_page', page);
  qa('.page').forEach(p => p.classList.remove('active'));
  qa('.nav-item,.mnb').forEach(n => n.classList.remove('active'));
  q('#page-' + page)?.classList.add('active');
  q(`[data-page="${page}"]`)?.classList.add('active');
  q('#mnb-' + page)?.classList.add('active');
  // FAB: show on dashboard/leads when mobile
  const fab = q('#fab-script');
  if (fab) fab.style.display = (page !== 'script') ? '' : 'none';
  if (page === 'dashboard') renderDashboard();
  if (page === 'leads') renderLeads();
  if (page === 'script') renderScript();
  if (page === 'users') renderUsers();
}

function goBack() {
  const prev = navStack.pop() || 'dashboard';
  navTo(prev, true);
}

// ─── DATA LOAD ────────────────────────────────────────────────
async function loadLeads() {
  const { data, error } = await sb.from('leads')
    .select('*, assigned_profile:profiles!assigned_to(full_name,email)')
    .order('created_at', { ascending: false });
  if (error) { console.error('loadLeads:', error); return; }
  allLeads = data || [];
}

async function loadUsers() {
  const { data } = await sb.from('profiles').select('*').order('full_name');
  allUsers = data || [];
  const sel = q('#assign-select');
  if (sel) sel.innerHTML = '<option value="">Assign to…</option>' +
    allUsers.map(u => `<option value="${u.id}">${esc(u.full_name || u.email)} (${u.role})</option>`).join('');
  const rf = q('#rep-filter');
  if (rf) {
    rf.innerHTML = '<option value="">All Reps</option>' +
      allUsers.filter(u => u.role === 'rep').map(u => `<option value="${u.id}">${esc(u.full_name || u.email)}</option>`).join('');
    rf.style.display = isAdmin() ? '' : 'none';
  }
}

async function loadProgress() {
  const today = todayStr();
  const { data } = await sb.from('daily_progress')
    .select('*').eq('user_id', currentProfile.id).eq('date', today).maybeSingle();
  if (data) { todayProgress = data; }
  else {
    const { data: row } = await sb.from('daily_progress')
      .upsert({ user_id: currentProfile.id, date: today, calls_done: 0, goal: todayProgress.goal },
        { onConflict: 'user_id,date' }).select().single();
    todayProgress = row || { calls_done: 0, goal: 20 };
  }
}

async function incrementProgress() {
  const today = todayStr();
  const done = (todayProgress.calls_done || 0) + 1;
  const { data } = await sb.from('daily_progress')
    .upsert({ user_id: currentProfile.id, date: today, calls_done: done, goal: todayProgress.goal },
      { onConflict: 'user_id,date' }).select().single();
  if (data) todayProgress = data;
  renderProgress(true);  // animate new segment fill
}

async function setGoal(delta) {
  const newGoal = Math.max(1, (todayProgress.goal || 20) + delta);
  const today = todayStr();
  const { data } = await sb.from('daily_progress')
    .upsert({ user_id: currentProfile.id, date: today, calls_done: todayProgress.calls_done || 0, goal: newGoal },
      { onConflict: 'user_id,date' }).select().single();
  if (data) todayProgress = data;
  renderProgress(false);
}

async function loadScript() {
  const { data } = await sb.from('scripts').select('*')
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  currentScript = data;
}

async function loadSettings() {
  const { data } = await sb.from('settings').select('key,value');
  if (data) {
    const bl = data.find(r => r.key === 'booking_link');
    bookingLink = bl?.value || '';
  }
}

async function saveSettings() {
  const link = q('#booking-link-input').value.trim();
  const { error } = await sb.from('settings')
    .upsert({ key: 'booking_link', value: link, updated_by: currentUser.id, updated_at: new Date().toISOString() },
      { onConflict: 'key' });
  if (error) { toast('❌ ' + error.message); return; }
  bookingLink = link;
  closeSettingsModal();
  toast('✓ Settings saved');
}

function openSettingsModal() {
  q('#booking-link-input').value = bookingLink;
  q('#settings-modal').classList.add('open');
}
function closeSettingsModal() { q('#settings-modal').classList.remove('open'); }

// ─── DASHBOARD ────────────────────────────────────────────────
function renderDashboard() {
  const today = todayStr();
  const thisMonth = today.slice(0, 7) + '-01';
  const active = allLeads.filter(l => l.status !== 'Closed Won' && l.status !== 'Not Interested');
  const overdue = active.filter(l => l.next_followup && l.next_followup < today);
  const dueToday = active.filter(l => l.next_followup === today);
  const unscheduled = active.filter(l => !l.next_followup && l.status !== 'Booked');
  const booked = allLeads.filter(l => l.status === 'Booked');
  const bookedToday = booked.filter(l => (l.updated_at || '').startsWith(today));
  const bookedMonth = booked.filter(l => (l.updated_at || '') >= thisMonth + 'T00:00:00');

  // Aggregate est_commission from DB-stored values (null-safe)
  const totalComm = booked.reduce((sum, l) => sum + (parseFloat(l.est_commission) || 0), 0);
  const commDisplay = totalComm > 0
    ? '$' + totalComm.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '—';

  // Card order: Total Leads | Due Today | Overdue | Booked Calls
  q('#stat-grid').innerHTML = `
    <div class="stat-card" onclick="navTo('leads')">
      <div class="stat-label">Total Leads</div>
      <div class="stat-value" style="color:var(--accent)">${allLeads.length}</div>
      <div class="stat-sub">in your pipeline</div>
    </div>
    <div class="stat-card" onclick="navTo('leads')">
      <div class="stat-label">Due Today</div>
      <div class="stat-value" style="color:#4ade80">${dueToday.length}</div>
      <div class="stat-sub">follow-ups today</div>
    </div>
    <div class="stat-card" onclick="navTo('leads')">
      <div class="stat-label">Overdue</div>
      <div class="stat-value" style="color:var(--yellow)">${overdue.length}</div>
      <div class="stat-sub">${unscheduled.length} unscheduled</div>
    </div>
    <div class="stat-card" id="card-booked" onclick="navTo('leads')">
      <div class="stat-label">🎯 Booked Calls</div>
      <div class="stat-value" style="color:var(--green);font-size:30px;font-weight:700">${booked.length}</div>
      <div class="stat-sub">${bookedToday.length} today · ${bookedMonth.length} this month</div>
      <div style="font-size:11px;color:var(--muted);margin-top:5px">Est. Commission: <span style="color:${totalComm > 0 ? 'var(--green)' : 'var(--muted)'};font-family:var(--mono);font-weight:600">${commDisplay}</span></div>
    </div>`;

  renderProgress();

  const queue = [
    ...overdue.sort((a, b) => a.next_followup < b.next_followup ? -1 : 1),
    ...dueToday,
  ];
  let html = '';
  if (overdue.length) {
    html += `<div class="sec-label"><span style="color:var(--red)">⚠ Overdue (${overdue.length})</span><span class="sep"></span></div>
      <div class="queue-list">${overdue.map(qCard).join('')}</div>`;
  }
  html += `<div class="sec-label" style="margin-top:${overdue.length ? 12 : 0}px">
    <span>Due Today (${dueToday.length})</span><span class="sep"></span></div>`;
  html += dueToday.length
    ? `<div class="queue-list">${dueToday.map(qCard).join('')}</div>`
    : `<div class="q-empty">✓ Nothing due today</div>`;
  q('#queue-section').innerHTML = html;
}

function renderProgress(animate = false) {
  const done = todayProgress.calls_done || 0;
  const goal = todayProgress.goal || 20;
  const SEGS = 10;
  const segsPerCall = goal / SEGS;           // calls per segment
  const filledSegs = Math.min(SEGS, Math.floor(done / segsPerCall));
  const partialPct = ((done % segsPerCall) / segsPerCall) * 100;

  // Color ramp: dark blue-gray → teal-green as progress grows
  const segColor = (i) => {
    if (i >= filledSegs) return null; // unfilled
    const t = i / (SEGS - 1);  // 0 → 1
    // Interpolate: #2a3a4a (cool dark) → #10b981 (emerald)
    const r = Math.round(42 + (16 - 42) * t);
    const g = Math.round(58 + (185 - 58) * t);
    const b = Math.round(74 + (129 - 74) * t);
    return `rgb(${r},${g},${b})`;
  };

  const helperText = done === 0 ? "Let's get started"
    : done >= goal ? '🎯 Target hit'
      : done >= goal * 0.8 ? 'Almost there'
        : done >= goal * 0.4 ? 'Good pace'
          : 'Building momentum';

  const segsHTML = Array.from({ length: SEGS }, (_, i) => {
    const color = segColor(i);
    const isFilled = i < filledSegs;
    const isNew = animate && i === filledSegs - 1;
    return `<div class="prog-seg${isFilled ? ' filled' : ''}${isNew ? ' pop' : ''}" style="${isFilled ? `background:${color};border-color:${color}` : ''}"></div>`;
  }).join('');

  const numColor = done >= goal ? 'var(--green)' : done > 0 ? 'var(--teal)' : 'var(--muted)';

  const el = q('#progress-wrap');
  if (!el) return;
  el.innerHTML = `
    <div class="progress-card">
      <div class="prog-header">
        <span class="prog-label">📞 Daily Calls</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="prog-nums" style="color:${numColor}">${done}<span style="font-size:13px;color:var(--muted)">/${goal}</span></span>
          <button class="btn btn-ghost btn-sm" onclick="setGoal(-5)" title="Lower goal" style="padding:3px 7px;font-size:14px">−</button>
          <button class="btn btn-ghost btn-sm" onclick="setGoal(5)"  title="Raise goal" style="padding:3px 7px;font-size:14px">+</button>
        </div>
      </div>
      <div class="prog-segs">${segsHTML}</div>
      <div class="prog-helper">
        <span>${helperText}</span>
      </div>
    </div>`;

  // Milestone pulse on the whole card at 5, 10, 20
  if (animate && (done === 5 || done === 10 || done === goal)) {
    const card = el.querySelector('.progress-card');
    card?.classList.add('prog-milestone');
    setTimeout(() => card?.classList.remove('prog-milestone'), 600);
  }
}

function qCard(l) {
  const today = todayStr();
  const od = l.next_followup && l.next_followup < today;
  const daysAgo = od ? Math.floor((new Date(today + 'T12:00:00') - new Date(l.next_followup + 'T12:00:00')) / 86400000) : 0;
  return `<div class="q-item" onclick="openLeadModal('${l.id}')">
    <div class="q-info">
      <div class="q-company">${esc(l.company)}</div>
      <div class="q-meta">${esc(l.contact_name || 'No contact')} · ${l.phone ? `<a href="tel:${esc(l.phone.replace(/\D/g, ''))}" onclick="event.stopPropagation()" style="color:var(--accent)">${esc(l.phone)}</a>` : 'No phone'}</div>
    </div>
    ${statusBadge(l.status)}
    ${od ? `<span class="overdue-tag">${daysAgo}d</span>` : ''}
    <button class="btn btn-green btn-sm" onclick="event.stopPropagation();showQuickLog(event,'${l.id}')">Log</button>
  </div>`;
}

// Inline quick-disposition buttons (subset of OUTCOMES for one-tap use)
// OUTCOMES indices: 0=No Answer, 1=Left VM, 2=Gatekeeper, 3=Called, 4=Booked, 5=Not Int., 6=Follow Up
const QUICK_BTNS = [
  { label: 'No Ans', idx: 0, style: 'background:var(--surface2);color:var(--dim);border-color:var(--border2)' },
  { label: 'Left VM', idx: 1, style: 'background:#1a2640;color:#60a5fa;border-color:#1e40af' },
  { label: 'GK', idx: 2, style: 'background:#1f1535;color:#c084fc;border-color:#6b21a8' },
  { label: 'Not Int', idx: 5, style: 'background:var(--red-dim);color:var(--red);border-color:#7f1d1d' },
  { label: 'Booked', idx: 4, style: 'background:var(--teal-dim);color:var(--teal);border-color:#0f766e' },
];

function renderLeads() {
  const qs = (q('#search-input')?.value || '').toLowerCase().trim();
  const sf = q('#status-filter')?.value || '';
  const rf = q('#rep-filter')?.value || '';
  const filtered = allLeads.filter(l => {
    const mq = !qs || (l.company || '').toLowerCase().includes(qs) || (l.contact_name || '').toLowerCase().includes(qs);
    return mq && (!sf || l.status === sf) && (!rf || l.assigned_to === rf);
  });
  q('#leads-count').textContent = `${filtered.length} lead${filtered.length !== 1 ? 's' : ''}`;

  // ── DESKTOP TABLE ──
  const adminCols = isAdmin()
    ? '<th style="width:24px"><input type="checkbox" id="sel-all" onchange="toggleSelAll(this)" style="accent-color:var(--accent)"></th><th>Assigned</th>'
    : '';
  q('#leads-thead').innerHTML = `${adminCols}<th>Company</th><th>Contact / Phone</th><th>Status</th><th>Next Step</th><th>Follow-Up</th><th>Last Activity</th><th></th>`;
  const tbody = q('#leads-tbody'), empty = q('#leads-empty');
  if (!filtered.length) { tbody.innerHTML = ''; empty.style.display = ''; }
  else {
    empty.style.display = 'none';
    const today = todayStr();
    tbody.innerHTML = filtered.map(l => {
      const od = l.next_followup && l.next_followup < today;
      const cb = isAdmin() ? `<td onclick="event.stopPropagation()"><input type="checkbox" class="lcb" data-id="${l.id}" onchange="updateBulkBar()" style="accent-color:var(--accent)"></td>` : '';
      const rep = isAdmin() ? `<td style="font-size:11px;color:var(--muted);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.assigned_profile?.full_name || l.assigned_profile?.email || '—')}</td>` : '';
      const quickBtns = QUICK_BTNS.map(b =>
        `<button onclick="event.stopPropagation();doQuickLog('${l.id}',${b.idx})" title="${OUTCOMES[b.idx].label}" style="padding:3px 7px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;border:1px solid;font-family:var(--sans);${b.style};-webkit-tap-highlight-color:transparent">${b.label}</button>`
      ).join('');
      const bookingBtns = bookingLink ? `
        <button onclick="event.stopPropagation();copyBookingLink('${l.id}')" title="Copy booking link" style="padding:3px 7px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;border:1px solid var(--teal);background:var(--teal-dim);color:var(--teal);font-family:var(--sans)">📋</button>
        <button onclick="event.stopPropagation();openBookingLink('${l.id}')" title="Open booking link" style="padding:3px 7px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;border:1px solid var(--teal);background:var(--teal-dim);color:var(--teal);font-family:var(--sans)">📅</button>` : '';
      return `<tr onclick="openLeadModal('${l.id}')">
        ${cb}${rep}
        <td style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.company)}</td>
        <td style="max-width:130px">
          <div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.contact_name || '—')}</div>
          ${l.phone ? `<a href="tel:${esc(l.phone.replace(/\D/g, ''))}" onclick="event.stopPropagation()" style="font-family:var(--mono);font-size:11px;color:var(--accent)">${esc(l.phone)}</a>` : ''}
        </td>
        <td>${statusBadge(l.status)}</td>
        <td style="max-width:140px">
          <input class="next-step-input" data-id="${l.id}" value="${esc(l.next_step || '')}" placeholder="Next step…" onclick="event.stopPropagation()" style="background:none;border:none;border-bottom:1px solid transparent;color:var(--text);font-size:12px;width:100%;outline:none;font-family:var(--sans);padding:2px 0;cursor:text"
            onfocus="this.style.borderBottomColor='var(--accent)'"
            onblur="saveNextStep('${l.id}',this.value);this.style.borderBottomColor='transparent'"
            onkeydown="if(event.key==='Enter'){this.blur()}" >
        </td>
        <td style="font-family:var(--mono);font-size:11px;white-space:nowrap${od ? ';color:var(--red)' : ''}">${fmtDate(l.next_followup)}</td>
        <td style="font-size:11px;color:var(--muted);white-space:nowrap">${relativeTime(l.last_activity_at)}</td>
        <td onclick="event.stopPropagation()">
          <div style="display:flex;gap:3px;flex-wrap:wrap;align-items:center">
            ${quickBtns}
            ${bookingBtns}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // ── MOBILE CARD LIST ──
  const mlist = q('#mobile-lead-list'); if (!mlist) return;
  if (!filtered.length) { mlist.innerHTML = '<div style="padding:28px 14px;text-align:center;color:var(--muted);font-size:13px">No leads found.</div>'; return; }
  const today2 = todayStr();
  mlist.innerHTML = filtered.map(l => {
    const od = l.next_followup && l.next_followup < today2;
    const repHtml = isAdmin() ? `<span class="m-lead-sub">${esc(l.assigned_profile?.full_name || l.assigned_profile?.email || 'Unassigned')}</span>` : '';
    const dateHtml = l.next_followup
      ? `<span class="m-date${od ? ' od' : ''}">${od ? '⚠ ' : ''}${fmtDate(l.next_followup)}</span>`
      : `<span class="m-date">No date</span>`;
    const actHtml = l.last_activity_at
      ? `<span class="m-date">${relativeTime(l.last_activity_at)}</span>` : '';
    const mobileQuickBtns = QUICK_BTNS.map(b =>
      `<button onclick="event.stopPropagation();doQuickLog('${l.id}',${b.idx})" style="flex:1;min-width:0;padding:10px 4px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid;font-family:var(--sans);text-align:center;${b.style};-webkit-tap-highlight-color:transparent">${b.label}</button>`
    ).join('');
    const mobileBooking = bookingLink ? `
      <div style="display:flex;gap:6px;margin-top:6px">
        <button onclick="event.stopPropagation();copyBookingLink('${l.id}')" style="flex:1;padding:9px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid var(--teal);background:var(--teal-dim);color:var(--teal);font-family:var(--sans)">📋 Copy Booking Link</button>
        <button onclick="event.stopPropagation();openBookingLink('${l.id}')" style="flex:1;padding:9px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid var(--teal);background:var(--teal-dim);color:var(--teal);font-family:var(--sans)">📅 Open Link</button>
      </div>` : '';
    return `<div class="m-lead-card" onclick="openLeadModal('${l.id}')">
      <div class="m-lead-top">
        <div class="m-lead-company">${esc(l.company)}</div>
        ${statusBadge(l.status)}
      </div>
      <div class="m-lead-meta">
        ${l.contact_name ? `<span class="m-lead-sub">${esc(l.contact_name)}</span>` : ''}
        ${repHtml}
        ${dateHtml}
        ${actHtml}
      </div>
      ${l.next_step ? `<div style="font-size:12px;color:var(--accent);margin-top:2px">→ ${esc(l.next_step)}</div>` : ''}
      <div class="m-lead-foot" style="margin-top:6px">
        ${l.phone ? `<a href="tel:${esc(l.phone.replace(/\D/g, ''))}" onclick="event.stopPropagation()" style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--accent);flex:1;display:flex;align-items:center;gap:6px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.92 13 19.79 19.79 0 0 1 1.87 4.37 2 2 0 0 1 3.84 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.98-.98a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 17z"/></svg>
          ${esc(l.phone)}</a>` : '<span style="flex:1;font-size:12px;color:var(--muted)">No phone</span>'}
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px" onclick="event.stopPropagation()">
        ${mobileQuickBtns}
      </div>
      ${mobileBooking}
    </div>`;
  }).join('');
}

// ─── LEAD MODAL ───────────────────────────────────────────────
// STATUSES defined above near OUTCOMES — using same canonical DB values

function openLeadModal(id) {
  const lead = id ? allLeads.find(l => l.id === id) : null;
  const isNew = !lead;
  q('#lead-modal-title').textContent = isNew ? 'Add Lead' : lead.company;
  const repOpts = isAdmin() ? `
    <div class="fg"><label>Assigned To</label>
      <select class="fi" id="lm-assigned">
        <option value="">Unassigned</option>
        ${allUsers.map(u => `<option value="${u.id}"${lead?.assigned_to === u.id ? ' selected' : ''}>${esc(u.full_name || u.email)}</option>`).join('')}
      </select></div>` : '';
  q('#lead-modal-body').innerHTML = `
    <div class="fg"><label>Company *</label><input class="fi" id="lm-company" value="${esc(lead?.company || '')}"></div>
    <div class="fgrid2">
      <div class="fg"><label>Phone</label><input class="fi" id="lm-phone" value="${esc(lead?.phone || '')}"></div>
      <div class="fg"><label>Email</label><input class="fi" type="email" id="lm-email" value="${esc(lead?.email || '')}"></div>
    </div>
    <div class="fgrid2">
      <div class="fg"><label>Contact Name</label><input class="fi" id="lm-contact" value="${esc(lead?.contact_name || '')}"></div>
      <div class="fg"><label>Who Answered</label><input class="fi" id="lm-who" value="${esc(lead?.who_answered || '')}"></div>
    </div>
    <div class="fgrid2">
      <div class="fg"><label>Status</label>
        <select class="fi" id="lm-status">
          ${STATUSES.map(s => `<option${lead?.status === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div class="fg"><label>Next Follow-Up</label><input class="fi" type="date" id="lm-followup" value="${lead?.next_followup || ''}"></div>
    </div>
    ${repOpts}
    <div class="fg"><label>Next Step</label><input class="fi" id="lm-next-step" placeholder="e.g. Call back Thursday, email proposal…" value="${esc(lead?.next_step || '')}"></div>
    <div class="fg"><label>Notes</label><textarea class="fi" id="lm-notes" rows="3">${esc(lead?.notes || '')}</textarea></div>
    ${lead ? `
    <div style="margin-top:8px;padding-top:10px;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;user-select:none">
          <input type="checkbox" id="lm-link-sent" ${lead.booking_link_sent ? 'checked' : ''} style="accent-color:var(--accent)">
          Booking link sent
        </label>
        ${lead.booked_at ? `<span style="font-size:11px;color:var(--green);font-family:var(--mono)">✓ Booked ${new Date(lead.booked_at).toLocaleDateString()}</span>` : ''}
      </div>
      <div class="fg" style="margin-bottom:0">
        <label>Est. Monthly Bill <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);font-size:10px">(optional — used to calc commission)</span></label>
        <div style="position:relative">
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-family:var(--mono);font-size:13px">$</span>
          <input class="fi" type="number" id="lm-est-bill" min="0" step="100" placeholder="e.g. 4000" value="${lead.est_monthly_bill || ''}" style="padding-left:22px">
        </div>
        ${lead.est_monthly_bill ? `<div style="font-size:11px;color:var(--muted);margin-top:3px">Est. commission: <span style="color:var(--green);font-family:var(--mono)">${'$' + (lead.est_monthly_bill * 0.025).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span></div>` : ''}
      </div>
    </div>
    <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Call History</div>
      <div id="call-log-list"></div></div>` : ''}`;
  const bookBtnHtml = (lead && bookingLink)
    ? `<button class="btn btn-teal btn-sm" onclick="openBookingLink('${lead.id}')">📅 Book with Don</button>`
    : '';
  q('#lead-modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeLeadModal()">Cancel</button>
    ${lead && isAdmin() ? `<button class="btn btn-danger btn-sm" onclick="deleteLead('${lead.id}')">Delete</button>` : ''}
    ${bookBtnHtml}
    <button class="btn btn-primary" onclick="saveLead(${lead ? `'${lead.id}'` : 'null'})">${isNew ? 'Add Lead' : 'Save'}</button>`;
  q('#lead-modal').classList.add('open');
  if (lead) loadCallLogs(lead.id);
  // Live commission preview as user types the bill amount
  const billInput = q('#lm-est-bill');
  if (billInput) {
    billInput.addEventListener('input', () => {
      const val = parseFloat(billInput.value) || 0;
      let preview = billInput.parentElement?.nextElementSibling;
      if (!preview) {
        preview = document.createElement('div');
        preview.style.cssText = 'font-size:11px;color:var(--muted);margin-top:3px';
        billInput.parentElement.after(preview);
      }
      preview.innerHTML = val > 0
        ? `Est. commission: <span style="color:var(--green);font-family:var(--mono)">$${(val * 0.025).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>`
        : '';
    });
  }
}  // end openLeadModal

async function loadCallLogs(leadId) {
  const { data } = await sb.from('call_logs')
    .select('*, user:profiles!user_id(full_name,email)')
    .eq('lead_id', leadId).order('logged_at', { ascending: false });
  const el = q('#call-log-list'); if (!el) return;
  if (!data?.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted)">No calls logged yet.</div>';
    return;
  }
  el.innerHTML = data.map((c, i) => {
    const canDelete = isAdmin() || c.user_id === currentUser.id;
    const isLatest = i === 0;   // first row is most recent (ordered desc)
    const deleteBtn = canDelete
      ? `<button onclick="deleteCallLog('${c.id}','${leadId}',${isLatest})" title="Delete this entry" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:2px 4px;border-radius:4px;line-height:1;transition:color .15s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>` : '';
    return `<div id="clog-${c.id}" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 11px;margin-bottom:5px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${new Date(c.logged_at).toLocaleDateString()}</span>
        ${statusBadge(c.outcome)}
        ${isLatest ? '<span style="font-size:9px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 5px;font-family:var(--mono);font-weight:700">latest</span>' : ''}
        <span style="font-size:11px;color:var(--muted);margin-left:auto">${esc(c.user?.full_name || c.user?.email || '')}</span>
        ${deleteBtn}
      </div>
      ${c.notes && c.notes !== c.outcome ? `<div style="font-size:12px;color:var(--dim);margin-top:3px">${esc(c.notes)}</div>` : ''}
    </div>`;
  }).join('');
}

function closeLeadModal() { q('#lead-modal').classList.remove('open'); }

// ─── DELETE CALL LOG + UNDO DISPOSITION ───────────────────────
// Double-tap confirmation: first click arms the button, second executes.
const _delConfirm = {};  // { [logId]: timeoutId }

async function deleteCallLog(logId, leadId, isLatest) {
  // Two-tap confirm: first tap turns button red and arms it for 3s
  if (!_delConfirm[logId]) {
    const btn = document.querySelector(`#clog-${logId} button[title]`);
    if (btn) {
      btn.style.color = 'var(--red)';
      btn.title = 'Tap again to confirm delete';
    }
    _delConfirm[logId] = setTimeout(() => {
      delete _delConfirm[logId];
      if (btn) { btn.style.color = 'var(--muted)'; btn.title = 'Delete this entry'; }
    }, 3000);
    return;
  }
  // Second tap — execute
  clearTimeout(_delConfirm[logId]);
  delete _delConfirm[logId];

  // Fetch the full log entry first (need prev_status, prev_followup, user_id, date)
  const { data: log, error: fetchErr } = await sb.from('call_logs')
    .select('*').eq('id', logId).single();
  if (fetchErr || !log) { toast('❌ Could not load log entry'); return; }

  const logDate = (log.logged_at || '').slice(0, 10); // YYYY-MM-DD
  const isToday = logDate === todayStr();

  // ── DELETE FROM SUPABASE FIRST, check it actually worked ──
  const { error: delErr, count: delCount } = await sb
    .from('call_logs')
    .delete({ count: 'exact' })
    .eq('id', logId);

  if (delErr) {
    toast('❌ Delete failed: ' + delErr.message);
    return;
  }
  if (delCount === 0) {
    // RLS blocked it silently — no policy allows this user to delete
    toast('❌ Not allowed to delete this entry');
    return;
  }

  // ── DELETE CONFIRMED — now apply side-effects ──

  // 1. Restore lead state (only if this was the latest log)
  const restore = { last_activity_at: new Date().toISOString() };
  if (isLatest) {
    if (log.prev_status) restore.status = log.prev_status;
    if (log.prev_followup !== undefined) restore.next_followup = log.prev_followup || null;
    if (log.outcome === 'Booked') restore.booked_at = log.prev_booked_at || null;
  }
  // Even for non-latest: if this was a win entry, clear booked_at
  if (!isLatest && log.outcome === 'Booked') {
    restore.booked_at = null;
  }
  await sb.from('leads').update(restore).eq('id', leadId);

  // 2. Decrement daily progress only if the log was created today
  if (isToday && log.user_id) {
    const { data: prog } = await sb.from('daily_progress')
      .select('calls_done').eq('user_id', log.user_id).eq('date', logDate).maybeSingle();
    if (prog && prog.calls_done > 0) {
      await sb.from('daily_progress')
        .update({ calls_done: prog.calls_done - 1 })
        .eq('user_id', log.user_id).eq('date', logDate);
      if (log.user_id === currentProfile.id) {
        todayProgress.calls_done = Math.max(0, (todayProgress.calls_done || 1) - 1);
        renderProgress();
      }
    }
  }

  // 3. Animate the row out, then reload from DB to confirm
  const entryEl = q(`#clog-${logId}`);
  if (entryEl) {
    entryEl.style.transition = 'opacity .2s, max-height .3s';
    entryEl.style.opacity = '0';
    entryEl.style.maxHeight = '0';
    entryEl.style.overflow = 'hidden';
    setTimeout(() => entryEl.remove(), 300);
  }

  const msg = isLatest && restore.status
    ? `✓ Removed — status restored to "${restore.status}"`
    : '✓ Log entry removed';
  toast(msg);

  // 4. Reload data to sync everything
  await loadLeads();
  renderDashboard();
  if (currentPage === 'leads') renderLeads();
  setTimeout(() => loadCallLogs(leadId), 320);
}

async function saveLead(id) {
  const company = q('#lm-company').value.trim();
  if (!company) { toast('Company name required'); return; }
  const payload = {
    company,
    phone: q('#lm-phone').value.trim(),
    email: q('#lm-email').value.trim(),
    contact_name: q('#lm-contact').value.trim(),
    who_answered: q('#lm-who').value.trim(),
    status: q('#lm-status').value,
    next_followup: q('#lm-followup').value || null,
    next_step: q('#lm-next-step').value.trim(),
    notes: q('#lm-notes').value.trim(),
    booking_link_sent: q('#lm-link-sent')?.checked || false,
    last_activity_at: new Date().toISOString(),
  };
  // Compute and persist est_commission whenever est_monthly_bill is set
  const rawBill = q('#lm-est-bill')?.value;
  const bill = rawBill ? parseFloat(rawBill) : null;
  payload.est_monthly_bill = bill;
  payload.est_commission = bill != null ? Math.round(bill * 0.025 * 100) / 100 : null;
  // Auto-set booked_at when status becomes Booked
  if (id) {
    const prev = allLeads.find(l => l.id === id);
    if (payload.status === 'Booked' && prev?.status !== 'Booked') {
      payload.booked_at = new Date().toISOString();
    }
  }
  if (isAdmin() && q('#lm-assigned')) payload.assigned_to = q('#lm-assigned').value || null;
  if (!id) {
    payload.uploaded_by = currentUser.id;
    if (!payload.assigned_to) payload.assigned_to = currentProfile.id;
  }
  console.log('[saveLead] writing status:', JSON.stringify(payload.status), '| est_commission:', payload.est_commission);
  const { error } = id
    ? await sb.from('leads').update(payload).eq('id', id)
    : await sb.from('leads').insert(payload);
  if (error) { toast('❌ ' + error.message); return; }
  toast(id ? '✓ Lead saved' : '✓ Lead added');
  closeLeadModal();
  await loadLeads();
  renderDashboard();
  if (currentPage === 'leads') renderLeads();
}

function openBookingLink(leadId) {
  if (!bookingLink) { toast('No booking link configured'); return; }
  window.open(bookingLink, '_blank', 'noopener');
  const lead = allLeads.find(l => l.id === leadId);
  if (lead && !lead.booking_link_sent) {
    sb.from('leads').update({ booking_link_sent: true, last_activity_at: new Date().toISOString() }).eq('id', leadId).then(async () => {
      await loadLeads();
      if (currentPage === 'leads') renderLeads();
    });
  }
}

async function copyBookingLink(leadId) {
  if (!bookingLink) { toast('No booking link configured'); return; }
  try {
    await navigator.clipboard.writeText(bookingLink);
    toast('✓ Booking link copied');
  } catch {
    // Fallback for browsers that block clipboard without HTTPS
    const ta = document.createElement('textarea');
    ta.value = bookingLink; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('✓ Booking link copied');
  }
  // Mark as sent
  const lead = allLeads.find(l => l.id === leadId);
  if (lead && !lead.booking_link_sent) {
    await sb.from('leads').update({ booking_link_sent: true, last_activity_at: new Date().toISOString() }).eq('id', leadId);
    await loadLeads();
    if (currentPage === 'leads') renderLeads();
  }
}

async function saveNextStep(leadId, value) {
  const prev = allLeads.find(l => l.id === leadId);
  if (!prev || prev.next_step === value) return; // no change
  const { error } = await sb.from('leads')
    .update({ next_step: value.trim(), last_activity_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) { toast('❌ ' + error.message); return; }
  // Update local cache without full reload
  prev.next_step = value.trim();
  prev.last_activity_at = new Date().toISOString();
}

async function deleteLead(id) {
  const { error } = await sb.from('leads').delete().eq('id', id);
  if (error) { toast('❌ ' + error.message); return; }
  toast('✓ Deleted');
  closeLeadModal();
  await loadLeads(); renderDashboard();
  if (currentPage === 'leads') renderLeads();
}

// ─── QUICK LOG ────────────────────────────────────────────────
// ─── VALID STATUS VALUES (must match DB check constraint exactly) ─────────────
// DB allows: 'New', 'Trying To Reach', 'Called', 'Left VM',
//            'Not Interested', 'Follow Up', 'Booked'
const STATUSES = ['New', 'Trying To Reach', 'Called', 'Left VM', 'Not Interested', 'Follow Up', 'Booked'];

// Canonical DB status mapper — use this everywhere a status string is written to Supabase
function toDbStatus(s) {
  if (!s) return 'New';
  const map = {
    // Old values → new DB values
    'trying to reach': 'Trying To Reach',
    'connected': 'Called',
    'follow up': 'Follow Up',
    'not interested': 'Not Interested',
    'closed won': 'Booked',
    'appointment set': 'Booked',
    // Already-correct values (lowercase match)
    'new': 'New',
    'called': 'Called',
    'left vm': 'Left VM',
    'booked': 'Booked',
  };
  return map[s.toLowerCase().trim()] || s;
}

const OUTCOMES = [
  { label: 'No Answer', outcome: 'No Answer', status: 'Trying To Reach', days: 1, color: 'var(--surface2)', tc: 'var(--dim)' },
  { label: 'Left VM', outcome: 'Left VM', status: 'Left VM', days: 2, color: '#1a2640', tc: '#60a5fa' },
  { label: 'Gatekeeper', outcome: 'Gatekeeper', status: 'Trying To Reach', days: 1, color: '#1f1535', tc: '#c084fc' },
  { label: 'Called', outcome: 'Called', status: 'Called', days: 3, color: 'var(--green-dim)', tc: 'var(--green)' },
  { label: 'Booked', outcome: 'Booked', status: 'Booked', days: null, color: 'var(--teal-dim)', tc: 'var(--teal)' },
  { label: 'Not Int.', outcome: 'Not Interested', status: 'Not Interested', days: null, color: 'var(--red-dim)', tc: 'var(--red)' },
  { label: 'Follow Up', outcome: 'Follow Up', status: 'Follow Up', days: 5, color: 'var(--yellow-dim)', tc: 'var(--yellow)' },
];

let activePopup = null;

function showQuickLog(event, leadId) {
  event.stopPropagation();
  if (activePopup) { activePopup.remove(); activePopup = null; }
  const popup = document.createElement('div');
  const isMob = window.innerWidth <= 680;
  if (isMob) {
    // Mobile: sheet from bottom
    popup.style.cssText = 'position:fixed;z-index:500;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--border);border-radius:16px 16px 0 0;padding:14px 14px 28px;box-shadow:0 -8px 32px rgba(0,0,0,.5)';
    popup.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;padding:0 2px">Log outcome</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
        ${OUTCOMES.map((o, i) => `<button onclick="doQuickLog('${leadId}',${i})" style="padding:14px 10px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid ${o.tc}33;background:${o.color};color:${o.tc};font-family:var(--sans);text-align:center;-webkit-tap-highlight-color:transparent">${o.label}</button>`).join('')}
      </div>`;
  } else {
    // Desktop: small popup near button
    const rect = event.currentTarget.getBoundingClientRect();
    const top = Math.min(rect.bottom + 6, window.innerHeight - 260);
    const left = Math.max(8, Math.min(rect.left - 60, window.innerWidth - 290));
    popup.style.cssText = `position:fixed;z-index:500;top:${top}px;left:${left}px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:7px;box-shadow:0 8px 32px rgba(0,0,0,.55);min-width:270px`;
    popup.innerHTML = OUTCOMES.map((o, i) =>
      `<button onclick="doQuickLog('${leadId}',${i})" style="padding:11px 8px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid ${o.tc}33;background:${o.color};color:${o.tc};font-family:var(--sans);text-align:center;-webkit-tap-highlight-color:transparent">${o.label}</button>`
    ).join('');
  }
  // backdrop for mobile
  if (isMob) {
    const bd = document.createElement('div');
    bd.style.cssText = 'position:fixed;inset:0;z-index:499;background:rgba(0,0,0,.5)';
    bd.onclick = () => { bd.remove(); popup.remove(); activePopup = null; };
    document.body.appendChild(bd);
    popup._backdrop = bd;
  }
  document.body.appendChild(popup);
  activePopup = popup;
  if (!isMob) {
    const close = e => { if (!popup.contains(e.target)) { popup.remove(); activePopup = null; document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

async function doQuickLog(leadId, idx) {
  if (activePopup) {
    activePopup._backdrop?.remove();
    activePopup.remove(); activePopup = null;
  }
  const o = OUTCOMES[idx];
  const today = todayStr();
  const lead = allLeads.find(l => l.id === leadId);

  let nextFollowup = null;
  if (o.days) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + o.days);
    nextFollowup = d.toISOString().split('T')[0];
  }

  const updates = { status: o.status, last_contact: today, last_activity_at: new Date().toISOString() };
  if (nextFollowup) updates.next_followup = nextFollowup;

  // Auto-set booked_at when marking Booked
  const isBooking = o.status === 'Booked' && lead?.status !== 'Booked';
  if (isBooking) updates.booked_at = new Date().toISOString();

  // DEBUG — visible in browser console so you can verify exact value sent
  console.log('[doQuickLog] leadId:', leadId, '| writing status:', JSON.stringify(updates.status), '| full updates:', updates);

  const logEntry = {
    lead_id: leadId,
    user_id: currentUser.id,
    outcome: o.outcome,
    notes: o.label,
    prev_status: lead?.status || null,
    prev_followup: lead?.next_followup || null,
    prev_booked_at: lead?.booked_at || null,
  };

  const [upd, log] = await Promise.all([
    sb.from('leads').update(updates).eq('id', leadId),
    sb.from('call_logs').insert(logEntry),
  ]);

  console.log('[doQuickLog] update result:', upd.error ? 'ERROR: ' + upd.error.message : 'OK');
  if (upd.error) { toast('❌ ' + upd.error.message); return; }

  toast(isBooking ? '🎯 Call booked!' : '✓ ' + o.label);
  if (isBooking) { pulseBookedCard(); launchConfetti(); }

  await Promise.all([incrementProgress(), loadLeads()]);
  renderDashboard();
  if (currentPage === 'leads') renderLeads();
}

// ─── BULK ASSIGN ──────────────────────────────────────────────
function toggleSelAll(cb) { qa('.lcb').forEach(el => el.checked = cb.checked); updateBulkBar(); }
function updateBulkBar() {
  const n = qa('.lcb:checked').length;
  const bar = q('#bulk-bar');
  bar.style.display = n ? 'flex' : 'none';
  q('#bulk-count').textContent = `${n} selected`;
}
function clearBulk() {
  qa('.lcb').forEach(el => el.checked = false);
  const sa = q('#sel-all'); if (sa) sa.checked = false;
  q('#bulk-bar').style.display = 'none';
}
async function bulkAssign() {
  const to = q('#assign-select').value;
  if (!to) { toast('Pick a rep first'); return; }
  const ids = Array.from(qa('.lcb:checked')).map(cb => cb.dataset.id);
  const { error } = await sb.from('leads').update({ assigned_to: to }).in('id', ids);
  if (error) { toast('❌ ' + error.message); return; }
  toast(`✓ ${ids.length} lead${ids.length !== 1 ? 's' : ''} assigned`);
  clearBulk();
  await loadLeads(); renderLeads();
}

// ─── SCRIPT ───────────────────────────────────────────────────
function buildScriptHTML(script, idPrefix = 'sp') {
  if (!script) return '<div style="color:var(--muted);text-align:center;padding:36px">No script yet. Admin can create one.</div>';
  const s = script;
  const secs = [
    { tab: 'Opener', key: 'opener' },
    { tab: 'Gatekeeper', key: 'gatekeeper' },
    { tab: 'Voicemail', key: 'voicemail' },
    { tab: 'Objections', key: 'objections' },
  ].filter(sec => s[sec.key]);
  if (!secs.length) return '<div style="color:var(--muted);padding:20px">Script is empty.</div>';
  return `
    <h2 style="font-size:15px;font-weight:700;margin-bottom:12px">${esc(s.name || 'Call Script')}</h2>
    <div class="script-tabs">${secs.map((sec, i) =>
    `<button class="script-tab${i === 0 ? ' active' : ''}" onclick="switchTab(this,'${idPrefix}-${i}','${idPrefix}')">${sec.tab}</button>`).join('')}</div>
    ${secs.map((sec, i) =>
      `<div class="script-panel${i === 0 ? ' active' : ''}" id="${idPrefix}-${i}"><div class="script-text">${esc(s[sec.key])}</div></div>`).join('')}`;
}

function switchTab(btn, panelId, prefix) {
  const wrap = btn.closest('.mbody, #script-view');
  wrap?.querySelectorAll('.script-tab').forEach(t => t.classList.remove('active'));
  wrap?.querySelectorAll('.script-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(panelId)?.classList.add('active');
}

function renderScript() {
  q('#script-view').innerHTML = buildScriptHTML(currentScript, 'scp');
}

function openScriptQuick() { openScriptPanel(); }  // legacy alias
function closeScriptQuick() { closeScriptPanel(); } // legacy alias

// ─── FLOATING SCRIPT PANEL ────────────────────────────────────
const SF_KEY = 'crm_script_float';
let _sfDragging = false, _sfResizing = false;

function scriptFloatState() {
  try { return JSON.parse(localStorage.getItem(SF_KEY) || '{}'); } catch { return {}; }
}
function saveScriptFloatState(patch) {
  const s = { ...scriptFloatState(), ...patch };
  localStorage.setItem(SF_KEY, JSON.stringify(s));
}

function openScriptPanel() {
  if (window.innerWidth <= 680) { openScriptSheet(); return; }
  openScriptFloat();
}
function closeScriptPanel() {
  closeScriptFloat(); closeScriptSheet();
}

function openScriptFloat() {
  const panel = q('#script-float');
  const mini = q('#script-mini');
  if (!panel) return;
  const s = scriptFloatState();
  panel.style.width = (s.w || 380) + 'px';
  panel.style.height = (s.h || 420) + 'px';
  panel.style.left = (s.x || Math.max(20, window.innerWidth - 420)) + 'px';
  panel.style.top = (s.y || 80) + 'px';
  panel.classList.add('open');
  if (mini) mini.style.display = 'none';
  q('#sf-edit-btn').style.display = isAdmin() ? '' : 'none';
  refreshScriptFloatBody();
  saveScriptFloatState({ open: true, minimized: false });
}

function closeScriptFloat() {
  q('#script-float')?.classList.remove('open');
  q('#script-mini').style.display = 'none';
  saveScriptFloatState({ open: false, minimized: false });
}

function minimizeScriptFloat() {
  q('#script-float')?.classList.remove('open');
  const mini = q('#script-mini');
  if (mini) mini.style.display = 'inline-flex';
  saveScriptFloatState({ minimized: true });
}

function refreshScriptFloatBody() {
  const body = q('#script-float-body');
  if (body) body.innerHTML = buildScriptHTML(currentScript, 'sf');
}

// Drag
(function () {
  let ox, oy, sx, sy;
  document.addEventListener('mousedown', e => {
    const hdr = e.target.closest('#script-float-header');
    if (!hdr) return;
    _sfDragging = true;
    const panel = q('#script-float');
    const r = panel.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!_sfDragging) return;
    const panel = q('#script-float');
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - ox));
    const y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - oy));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!_sfDragging) return;
    _sfDragging = false;
    const panel = q('#script-float');
    if (panel) saveScriptFloatState({ x: parseInt(panel.style.left), y: parseInt(panel.style.top) });
  });
})();

// Resize
(function () {
  let startX, startY, startW, startH;
  const getRz = () => q('#script-float-resize');
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#script-float-resize')) return;
    _sfResizing = true;
    const panel = q('#script-float');
    const r = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startW = r.width; startH = r.height;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!_sfResizing) return;
    const panel = q('#script-float');
    const w = Math.max(280, startW + (e.clientX - startX));
    const h = Math.max(180, startH + (e.clientY - startY));
    panel.style.width = w + 'px'; panel.style.height = h + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!_sfResizing) return;
    _sfResizing = false;
    const panel = q('#script-float');
    if (panel) saveScriptFloatState({ w: parseInt(panel.style.width), h: parseInt(panel.style.height) });
  });
})();

// ─── MOBILE SCRIPT SHEET ──────────────────────────────────────
let _sheetExpanded = false;

function openScriptSheet() {
  const sheet = q('#script-sheet');
  const bd = q('#script-sheet-backdrop');
  if (!sheet) return;
  sheet.classList.add('open');
  bd?.classList.add('open');
  _sheetExpanded = true;
  q('#script-sheet-arrow').textContent = '▼';
  q('#ss-edit-btn').style.display = isAdmin() ? '' : 'none';
  const body = q('#script-sheet-body');
  if (body) body.innerHTML = buildScriptHTML(currentScript, 'ss');
}

function closeScriptSheet() {
  q('#script-sheet')?.classList.remove('open');
  q('#script-sheet-backdrop')?.classList.remove('open');
  _sheetExpanded = false;
}

function toggleScriptSheet() {
  if (_sheetExpanded) closeScriptSheet(); else openScriptSheet();
}

// Touch drag on sheet handle to resize height
(function () {
  let startY, startH;
  const getHandle = () => q('#script-sheet-drag-bar');
  document.addEventListener('touchstart', e => {
    if (!e.target.closest('#script-sheet-drag-bar')) return;
    startY = e.touches[0].clientY;
    startH = q('#script-sheet')?.getBoundingClientRect().height || 300;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (startY === undefined) return;
    const sheet = q('#script-sheet');
    if (!sheet) return;
    const dy = startY - e.touches[0].clientY;
    const h = Math.max(120, Math.min(window.innerHeight * 0.85, startH + dy));
    sheet.style.maxHeight = h + 'px';
  }, { passive: true });
  document.addEventListener('touchend', () => { startY = undefined; });
})();

// ─── CONFETTI ─────────────────────────────────────────────────
function launchConfetti() {
  const canvas = q('#confetti-canvas');
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  const pieces = Array.from({ length: 60 }, () => ({
    x: Math.random() * canvas.width,
    y: -10 - Math.random() * 40,
    r: 3 + Math.random() * 4,
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 3,
    color: ['#22c55e', '#2dd4bf', '#4f8aff', '#c9980a', '#a855f7'][Math.floor(Math.random() * 5)],
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.2,
    life: 1,
  }));
  let frame;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of pieces) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.08;
      p.angle += p.spin; p.life -= 0.018;
      if (p.life <= 0 || p.y > canvas.height) continue;
      alive = true;
      ctx.save(); ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    }
    if (alive) { frame = requestAnimationFrame(tick); }
    else { canvas.style.display = 'none'; cancelAnimationFrame(frame); }
  }
  tick();
}

function pulseBookedCard() {
  const card = q('#card-booked');
  if (!card) return;
  card.classList.remove('booked-pulse');
  void card.offsetWidth; // force reflow
  card.classList.add('booked-pulse');
  setTimeout(() => card.classList.remove('booked-pulse'), 900);
}

// Restore script panel on boot if it was open
function restoreScriptFloat() {
  if (window.innerWidth <= 680) return;
  const s = scriptFloatState();
  if (s.open && !s.minimized) openScriptFloat();
  else if (s.minimized) {
    const mini = q('#script-mini');
    if (mini) mini.style.display = 'inline-flex';
  }
}

function openScriptEditModal() {
  if (!currentScript) return;
  q('#se-name').value = currentScript.name || '';
  q('#se-opener').value = currentScript.opener || '';
  q('#se-gatekeeper').value = currentScript.gatekeeper || '';
  q('#se-voicemail').value = currentScript.voicemail || '';
  q('#se-objections').value = currentScript.objections || '';
  q('#script-edit-modal').classList.add('open');
}
function closeScriptEditModal() { q('#script-edit-modal').classList.remove('open'); }

async function saveScript() {
  const payload = {
    name: q('#se-name').value.trim(),
    opener: q('#se-opener').value.trim(),
    gatekeeper: q('#se-gatekeeper').value.trim(),
    voicemail: q('#se-voicemail').value.trim(),
    objections: q('#se-objections').value.trim(),
    updated_by: currentUser.id,
    updated_at: new Date().toISOString(),
  };
  const { error } = currentScript?.id
    ? await sb.from('scripts').update(payload).eq('id', currentScript.id)
    : await sb.from('scripts').insert(payload);
  if (error) { toast('❌ ' + error.message); return; }
  closeScriptEditModal();
  await loadScript();
  renderScript();
  refreshScriptFloatBody();  // update float panel if open
  toast('✓ Script saved');
}

// ─── USERS ────────────────────────────────────────────────────
async function renderUsers() {
  await loadUsers();
  const today = todayStr();
  const thisMonth = today.slice(0, 7) + '-01';
  const { data: progData } = await sb.from('daily_progress').select('user_id,calls_done').eq('date', today);
  const progMap = Object.fromEntries((progData || []).map(p => [p.user_id, p.calls_done]));
  const tbody = q('#users-tbody');
  if (!allUsers.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">No users.</td></tr>'; return; }
  tbody.innerHTML = allUsers.map(u => {
    const ul = allLeads.filter(l => l.assigned_to === u.id);
    const due = ul.filter(l => l.next_followup === today).length;
    const od = ul.filter(l => l.next_followup && l.next_followup < today && l.status !== 'Closed Won').length;
    const wins = ul.filter(l => l.status === 'Booked' && (l.updated_at || '') >= thisMonth + 'T00:00:00').length;
    const calls = progMap[u.id] || 0;
    return `<tr>
      <td><div style="font-weight:600">${esc(u.full_name || '—')}</div><div style="font-size:11px;color:var(--muted)">${esc(u.email)}</div></td>
      <td>${u.role === 'admin' ? '<span class="badge b-admin">admin</span>' : '<span class="badge b-rep">rep</span>'}</td>
      <td style="font-family:var(--mono)">${ul.length}</td>
      <td style="font-family:var(--mono);color:var(--yellow)">${due}</td>
      <td style="font-family:var(--mono);color:var(--red)">${od}</td>
      <td style="font-family:var(--mono);color:var(--accent)">${calls}</td>
      <td style="font-family:var(--mono);color:var(--green)">${wins}</td>
    </tr>`;
  }).join('');
}

// ─── CSV UPLOAD ───────────────────────────────────────────────
// ─── CSV UPLOAD — PREVIEW + CONFIRM + UNDO ────────────────────
const CSV_MAP = {
  company: ['company', 'location', 'account', 'business', 'facility'],
  phone: ['phone', 'telephone', 'phone number', 'tel'],
  contact_name: ['contact', 'contact name', 'name'],
  contact_title: ['title', 'contact title', 'job title'],
  email: ['email', 'e-mail', 'email address'],
  status: ['status', 'lead status'],
  next_followup: ['next follow-up date', 'next follow up date', 'follow-up date', 'follow up date', 'next follow-up', 'followup', 'next call'],
  notes: ['notes', 'note', 'comments'],
};
function normH(h) { return h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' '); }
function normSt(v) {
  if (!v) return 'New';
  const lv = v.toLowerCase().trim();
  if (lv === 'not called' || lv === 'new') return 'New';
  if (lv.includes('appointment') || lv === 'booked') return 'Booked';
  if (lv.includes('not interested')) return 'Not Interested';
  if (lv.includes('closed') || lv.includes('won')) return 'Booked';
  if (lv.includes('follow')) return 'Follow Up';
  if (lv === 'left vm' || lv.includes('voicemail') || lv.includes('vm')) return 'Left VM';
  if (lv.includes('connect') || lv.includes('spoke') || lv === 'called') return 'Called';
  if (lv.includes('try') || lv.includes('reach')) return 'Trying To Reach';
  return 'New';
}
function normDt(v) {
  if (!v) return null;
  const c = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  const m = c.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return null;
}
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  const parse = line => { const cols = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"' && !inQ) inQ = true; else if (c === '"' && inQ) { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; } else cur += c; } cols.push(cur.trim()); return cols; };
  const headers = parse(lines[0]).map(h => h.replace(/^\uFEFF/, '').trim());
  const rows = lines.slice(1).map(l => { const v = parse(l); const o = {}; headers.forEach((h, i) => o[h] = (v[i] || '').trim()); return o; }).filter(r => Object.values(r).some(v => v));
  return { headers, rows };
}

function openCsvModal() {
  pendingImport = null;
  q('#csv-step1').style.display = '';
  q('#csv-step2').style.display = 'none';
  q('#csv-status').textContent = '';
  q('#csv-upload-status').textContent = '';
  q('#csv-confirm-btn').style.display = 'none';
  q('#csv-modal-title').textContent = 'Upload CSV';
  q('#csv-file').value = '';
  // Show undo button if there's a previous batch to undo
  checkUndoBtnVisibility();
  q('#csv-modal').classList.add('open');
}
function closeCsvModal() {
  pendingImport = null;
  q('#csv-modal').classList.remove('open');
}

async function checkUndoBtnVisibility() {
  const btn = q('#csv-undo-btn'); if (!btn) return;
  const { data } = await sb.from('leads')
    .select('import_batch_id').not('import_batch_id', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  btn.style.display = data ? '' : 'none';
}

async function previewCSV() {
  const file = q('#csv-file').files[0];
  const status = q('#csv-status');
  if (!file) return;
  status.textContent = 'Parsing…';
  let text;
  try { text = await file.text(); } catch (e) { status.textContent = '❌ Could not read file'; return; }
  const { headers, rows } = parseCSV(text);

  // Map headers
  const fm = {}, used = new Set();
  for (const [key, aliases] of Object.entries(CSV_MAP)) {
    for (const h of headers) {
      if (used.has(h)) continue;
      const hn = normH(h);
      if (aliases.includes(hn) || aliases.some(a => hn.includes(a) || a.includes(hn))) {
        fm[key] = h; used.add(h); break;
      }
    }
  }
  status.textContent = `Columns mapped: ${Object.entries(fm).map(([k, v]) => `${k}←"${v}"`).join(', ')}`;

  const get = (row, key) => fm[key] ? (row[fm[key]] || '').trim() : '';
  const valid = rows.filter(r => get(r, 'company'));
  const skipped = rows.length - valid.length;

  const batchId = 'batch-' + Date.now();
  pendingImport = {
    batchId,
    leads: valid.map(r => ({
      company: get(r, 'company'),
      phone: get(r, 'phone'),
      contact_name: get(r, 'contact_name'),
      email: get(r, 'email'),
      status: normSt(get(r, 'status')),
      next_followup: normDt(get(r, 'next_followup')),
      notes: get(r, 'notes'),
      uploaded_by: currentUser.id,
      assigned_to: currentProfile.id,
      import_batch_id: batchId,
    })),
  };

  // Render preview stats
  q('#csv-preview-stats').innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <div><span style="font-size:18px;font-weight:700;color:var(--accent);font-family:var(--mono)">${rows.length}</span> <span style="color:var(--muted);font-size:12px">rows detected</span></div>
      <div><span style="font-size:18px;font-weight:700;color:var(--green);font-family:var(--mono)">${valid.length}</span> <span style="color:var(--muted);font-size:12px">valid leads</span></div>
      ${skipped ? `<div><span style="font-size:18px;font-weight:700;color:var(--yellow);font-family:var(--mono)">${skipped}</span> <span style="color:var(--muted);font-size:12px">skipped (no company)</span></div>` : ''}
    </div>`;

  // Sample table — first 5 rows
  const sample = pendingImport.leads.slice(0, 5);
  const colKeys = ['company', 'phone', 'contact_name', 'status', 'next_followup'];
  const colLabels = ['Company', 'Phone', 'Contact', 'Status', 'Follow-Up'];
  q('#csv-preview-table').innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>${colLabels.map(l => `<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);color:var(--muted);font-size:10px;text-transform:uppercase;font-weight:700;white-space:nowrap">${l}</th>`).join('')}</tr></thead>
      <tbody>${sample.map(l => `<tr>${colKeys.map(k => `<td style="padding:6px 10px;border-bottom:1px solid var(--border);color:var(--dim);white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(l[k] || '—')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    ${valid.length > 5 ? `<div style="padding:6px 10px;font-size:11px;color:var(--muted)">…and ${valid.length - 5} more</div>` : ''}`;

  q('#csv-step2').style.display = '';
  q('#csv-confirm-btn').style.display = '';
  q('#csv-modal-title').textContent = 'Confirm Import';
  if (!valid.length) {
    q('#csv-confirm-btn').style.display = 'none';
    q('#csv-upload-status').textContent = '❌ No valid leads found — check headers';
  }
}

async function confirmCSV() {
  if (!pendingImport?.leads?.length) return;
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'append';
  const status = q('#csv-upload-status');
  const confirmBtn = q('#csv-confirm-btn');
  confirmBtn.disabled = true; confirmBtn.textContent = 'Importing…';

  if (mode === 'replace') {
    status.textContent = 'Removing existing leads…';
    const { error } = await sb.from('leads').delete().eq('assigned_to', currentProfile.id);
    if (error) { status.textContent = '❌ Replace failed: ' + error.message; confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Import'; return; }
  }

  const leads = pendingImport.leads;
  const CHUNK = 50; let done = 0;
  for (let i = 0; i < leads.length; i += CHUNK) {
    const { error } = await sb.from('leads').insert(leads.slice(i, i + CHUNK));
    if (error) { status.textContent = `❌ Error at row ${i + 1}: ${error.message}`; confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Import'; return; }
    done += Math.min(CHUNK, leads.length - i);
    status.textContent = `Uploaded ${done}/${leads.length}…`;
  }

  status.textContent = `✅ Imported ${done} leads (batch: ${pendingImport.batchId})`;
  confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Import';
  pendingImport = null;
  await loadLeads(); renderDashboard();
  if (currentPage === 'leads') renderLeads();
  setTimeout(() => closeCsvModal(), 1400);
}

async function undoLastImport() {
  const { data } = await sb.from('leads')
    .select('import_batch_id').not('import_batch_id', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data?.import_batch_id) { toast('No import to undo'); return; }
  const batchId = data.import_batch_id;
  const { error, count } = await sb.from('leads')
    .delete({ count: 'exact' }).eq('import_batch_id', batchId);
  if (error) { toast('❌ ' + error.message); return; }
  toast(`✓ Removed ${count ?? '?'} leads from last import`);
  q('#csv-undo-btn').style.display = 'none';
  await loadLeads(); renderDashboard();
  if (currentPage === 'leads') renderLeads();
}

// ─── INVITE ───────────────────────────────────────────────────
function openInviteModal() { q('#invite-modal').classList.add('open'); }
function closeInviteModal() { q('#invite-modal').classList.remove('open'); }

// ─── BADGE ────────────────────────────────────────────────────
function statusBadge(s) {
  const m = {
    'New': 'b-new',
    'Trying To Reach': 'b-try', 'Trying to Reach': 'b-try',
    'Called': 'b-conn', 'Connected': 'b-conn',
    'Left VM': 'b-try',
    'Follow Up': 'b-follow',
    'Not Interested': 'b-notint',
    'Closed Won': 'b-won',
    'Booked': 'b-appt', 'Appointment Set': 'b-appt',
    // call log outcomes
    'No Answer': 'b-new', 'VM': 'b-try', 'Gatekeeper': 'b-follow',
    'Spoke': 'b-conn', 'Other': 'b-follow',
  };
  return `<span class="badge ${m[s] || 'b-new'}">${esc(s || 'New')}</span>`;
}

// ─── MODAL CLOSE HELPERS ──────────────────────────────────────
document.addEventListener('click', e => {
  ['lead-modal', 'csv-modal', 'invite-modal', 'script-edit-modal', 'script-quick-modal', 'settings-modal'].forEach(id => {
    if (e.target === q('#' + id)) q('#' + id).classList.remove('open');
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    qa('.modal-bg.open').forEach(m => m.classList.remove('open'));
    if (activePopup) { activePopup._backdrop?.remove(); activePopup.remove(); activePopup = null; }
  }
});
