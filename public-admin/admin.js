// Operator console for DC Current staff.
//
// Served only on ADMIN_HOSTNAME — the server 404s these endpoints on any
// customer hostname, so this file is never even delivered elsewhere.
(function () {
  'use strict';

  var state = { me: null, csrf: null, tab: 'overview', tenants: [], staff: [] };

  var boot = document.getElementById('boot');
  var root = document.getElementById('root');

  /* ------------------------------------------------------------ helpers */

  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(path, options) {
    var opts = Object.assign({ headers: {} }, options || {});
    opts.credentials = 'same-origin';
    if (opts.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    if (state.csrf && opts.method && opts.method !== 'GET') {
      opts.headers['x-csrf-token'] = state.csrf;
    }
    var res = await fetch('/api/admin' + path, opts);
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      var err = new Error((data && data.message) || 'Something went wrong.');
      err.code = data && data.error;
      err.details = data && data.details;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function when(ts) {
    if (!ts) return '—';
    var d = new Date(ts), diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.round(diff / 60) + ' min ago';
    if (diff < 86400) return Math.round(diff / 3600) + ' hr ago';
    if (diff < 2592000) return Math.round(diff / 86400) + ' days ago';
    return d.toLocaleDateString();
  }

  function pill(value, cls) {
    return '<span class="pill ' + h(cls || value) + '">' + h(value) + '</span>';
  }

  /* ------------------------------------------------------------- modals */

  function closeModal() {
    var v = document.querySelector('.veil');
    if (v) v.remove();
  }

  function modal(title, sub, bodyHtml, onMount, opts) {
    closeModal();
    var veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML =
      '<div class="modal' + (opts && opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' +
        '<h3>' + h(title) + '</h3>' +
        (sub ? '<p class="sub">' + h(sub) + '</p>' : '') +
        bodyHtml +
      '</div>';
    veil.addEventListener('click', function (e) { if (e.target === veil) closeModal(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(veil);
    if (onMount) onMount(veil);
    var first = veil.querySelector('input, select, button');
    if (first) first.focus();
  }

  // A generated password is shown exactly once. Make that unmissable.
  function showSecret(title, who, password) {
    modal(title, who,
      '<div class="alert alert-warn">This is shown once and cannot be recovered. ' +
      'Copy it now and send it over a channel you trust.</div>' +
      '<div class="secret">' + h(password) + '</div>' +
      '<div class="row-end"><button class="btn" id="mdone">Done</button></div>',
      function (v) { v.querySelector('#mdone').addEventListener('click', closeModal); });
  }

  function formError(veil, err) {
    var box = veil.querySelector('.form-err');
    if (!box) return;
    var extra = '';
    if (err.details && err.details.length) {
      extra = ': ' + err.details.map(function (d) { return d.field + ' ' + d.problem; }).join('; ');
    }
    box.className = 'alert alert-err form-err';
    box.textContent = err.message + extra;
    box.hidden = false;
  }

  /* -------------------------------------------------------------- login */

  function renderLogin(message) {
    boot.hidden = true; root.hidden = false;
    root.innerHTML =
      '<div class="login-shell"><div class="login">' +
        '<div class="login-head"><div class="mark">DC</div>' +
          '<h1>Portal Admin</h1><p>DC Current Corp — staff only</p></div>' +
        '<div class="card">' +
          (message ? '<div class="alert alert-err">' + h(message) + '</div>' : '') +
          '<form id="lf" novalidate>' +
            '<div class="field"><label for="em">Email</label>' +
              '<input id="em" type="email" autocomplete="username" required></div>' +
            '<div class="field"><label for="pw">Password</label>' +
              '<input id="pw" type="password" autocomplete="current-password" required></div>' +
            '<button class="btn" id="lb" type="submit" style="width:100%">Sign in</button>' +
          '</form>' +
        '</div>' +
      '</div></div>';

    document.getElementById('lf').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = document.getElementById('lb');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        var out = await api('/login', { method: 'POST', body: {
          email: document.getElementById('em').value.trim(),
          password: document.getElementById('pw').value,
        }});
        state.csrf = out.csrfToken;
        state.me = await api('/me');
        renderApp();
      } catch (err) {
        renderLogin(err.message);
      }
    });
  }

  /* ---------------------------------------------------------------- app */

  function renderApp() {
    boot.hidden = true; root.hidden = false;
    var me = state.me;
    var tabs = [['overview', 'Overview'], ['tenants', 'Customers'], ['audit', 'Activity']];
    if (me.role === 'owner') tabs.push(['staff', 'Operators'], ['system', 'System']);

    root.innerHTML =
      '<div class="wrap">' +
        '<div class="top"><div class="mark">DC</div>' +
          '<div class="title">Portal Admin<span>STAFF CONSOLE</span></div>' +
          '<div class="grow"></div>' +
          '<div class="who"><b>' + h(me.name) + '</b>' + h(me.email) + ' · ' + h(me.role) + '</div>' +
          '<button class="btn-ghost" id="out">Sign out</button>' +
        '</div>' +
        '<div class="tabs" role="tablist">' +
          tabs.map(function (t) {
            return '<button class="tab" role="tab" data-tab="' + t[0] + '" aria-selected="' +
                   (state.tab === t[0]) + '">' + h(t[1]) + '</button>';
          }).join('') +
        '</div>' +
        '<div id="panel"></div>' +
      '</div>';

    document.getElementById('out').addEventListener('click', async function () {
      try { await api('/logout', { method: 'POST' }); } catch (_) {}
      state.me = null; state.csrf = null;
      renderLogin();
    });
    root.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.dataset.tab; renderApp(); });
    });

    ({ overview: panelOverview, tenants: panelTenants, audit: panelAudit,
       staff: panelStaff, system: panelSystem })[state.tab]();
  }

  function panel() { return document.getElementById('panel'); }

  /* ----------------------------------------------------------- overview */

  async function panelOverview() {
    panel().innerHTML = '<div class="empty">Loading…</div>';
    try {
      var d = await api('/overview');
      var c = d.counts;
      panel().innerHTML =
        '<div class="stats">' +
          stat('Active customers', c.active_tenants) +
          stat('Customer users', c.active_users) +
          stat('Events, 24h', c.events_24h) +
          stat('Failures, 24h', c.errors_24h, Number(c.errors_24h) > 0) +
        '</div>' +
        (Number(c.suspended_tenants) > 0
          ? '<div class="alert alert-warn">' + c.suspended_tenants +
            ' customer(s) suspended — their portals are not reachable.</div>'
          : '') +
        '<div class="card"><h2>Latest activity</h2>' +
          '<p class="desc">Everything happening across every customer, newest first.</p>' +
          auditTable(d.recent) +
        '</div>';
    } catch (err) {
      panel().innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    }
  }

  function stat(k, v, bad) {
    return '<div class="stat"><div class="k">' + h(k) + '</div>' +
           '<div class="v num' + (bad ? ' bad' : '') + '">' + h(v) + '</div></div>';
  }

  /* ------------------------------------------------------------ tenants */

  async function panelTenants() {
    panel().innerHTML = '<div class="empty">Loading…</div>';
    try {
      var d = await api('/tenants');
      state.tenants = d.tenants;
      panel().innerHTML =
        '<div class="card">' +
          '<div class="card-head"><h2>Customers</h2><div class="grow"></div>' +
            '<button class="btn" id="addT">Add customer</button></div>' +
          (d.tenants.length ? '<div class="tscroll"><table>' +
            '<thead><tr><th>Customer</th><th>Web address</th><th>SkySwitch domain</th>' +
            '<th>Ext</th><th>Users</th><th>Last activity</th><th>Status</th><th></th></tr></thead><tbody>' +
            d.tenants.map(tenantRow).join('') +
          '</tbody></table></div>' : '<div class="empty">No customers yet.</div>') +
        '</div>';

      // Wrapped: addEventListener passes the click Event as the first argument,
      // which tenantForm would read as "the tenant being edited".
      document.getElementById('addT').addEventListener('click', function () { tenantForm(); });
      panel().querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
          tenantForm(state.tenants.find(function (t) { return t.id === b.dataset.edit; }));
        });
      });
      panel().querySelectorAll('[data-users]').forEach(function (b) {
        b.addEventListener('click', function () {
          usersModal(state.tenants.find(function (t) { return t.id === b.dataset.users; }));
        });
      });
      panel().querySelectorAll('[data-status]').forEach(function (b) {
        b.addEventListener('click', function () { toggleTenant(b.dataset.status, b.dataset.to); });
      });
    } catch (err) {
      panel().innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    }
  }

  function tenantRow(t) {
    var sw = t.brand_color
      ? '<span class="swatch" style="background:' + h(t.brand_color) + '"></span>' : '';
    var flip = t.status === 'active' ? 'suspended' : 'active';
    return '<tr>' +
      '<td>' + sw + h(t.name) + '</td>' +
      '<td class="host">' + (t.hostname
        ? h(t.hostname)
        : '<span style="opacity:.65">shared portal</span>') + '</td>' +
      '<td class="host">' + h(t.ns_domain) + '</td>' +
      '<td class="host">' + (t.main_extension
        ? h(t.main_extension)
        : '<span style="color:var(--warn)">not set</span>') + '</td>' +
      '<td class="num">' + h(t.user_count) + '</td>' +
      '<td class="num">' + h(when(t.last_activity)) + '</td>' +
      '<td>' + pill(t.status) + '</td>' +
      '<td class="actions">' +
        '<button class="btn-ghost" data-users="' + h(t.id) + '">Users</button>' +
        '<button class="btn-ghost" data-edit="' + h(t.id) + '">Edit</button>' +
        '<button class="' + (t.status === 'active' ? 'btn-danger' : 'btn-ghost') +
          '" data-status="' + h(t.id) + '" data-to="' + flip + '">' +
          (t.status === 'active' ? 'Suspend' : 'Reactivate') + '</button>' +
      '</td></tr>';
  }

  function tenantForm(t) {
    // Only a real record counts as an edit. Guards against anything truthy
    // arriving here by accident — a click Event, most obviously.
    var editing = Boolean(t && t.id);
    if (!editing) t = null;
    modal(editing ? 'Edit customer' : 'Add customer',
      editing ? t.name : 'They get their own web address and their own look.',
      '<div class="alert form-err" hidden></div>' +
      '<div class="field"><label for="f_name">Customer name</label>' +
        '<input id="f_name" value="' + h(editing ? t.name : '') + '" placeholder="Acme Electric"></div>' +
      '<div class="field"><label for="f_host">Portal web address ' +
        '<span style="opacity:.6;font-weight:400">— optional</span></label>' +
        '<input id="f_host" value="' + h(editing ? (t.hostname || '') : '') +
        '" placeholder="leave blank to use the shared portal">' +
        '<div style="font-size:11.5px;color:var(--muted);margin-top:5px">' +
        'Blank means they sign in at the shared portal with everyone else. ' +
        'Give an address only if this customer wants their own.</div></div>' +
      '<div class="grid2">' +
        '<div class="field"><label for="f_ns">SkySwitch domain</label>' +
          '<input id="f_ns" value="' + h(editing ? t.ns_domain : '') + '" placeholder="acme.yourdomain.com"></div>' +
        '<div class="field"><label for="f_ext">Main extension</label>' +
          '<input id="f_ext" value="' + h(editing ? (t.main_extension || '') : '') + '" placeholder="2001"></div>' +
      '</div>' +
      '<div class="grid2">' +
        '<div class="field"><label for="f_color">Brand colour</label>' +
          '<input id="f_color" value="' + h(editing ? (t.brand_color || '') : '') + '" placeholder="#2F6FED"></div>' +
        '<div class="field"><label for="f_email">Support email</label>' +
          '<input id="f_email" value="' + h(editing ? (t.support_email || '') : '') + '" placeholder="help@…"></div>' +
      '</div>' +
      '<div class="field"><label for="f_phone">Support phone</label>' +
        '<input id="f_phone" value="' + h(editing ? (t.support_phone || '') : '') + '" placeholder="+1 518 555 0142"></div>' +
      '<div class="row-end"><button class="btn-ghost" id="mc">Cancel</button>' +
        '<button class="btn" id="ms">' + (editing ? 'Save' : 'Create') + '</button></div>',
      function (veil) {
        veil.querySelector('#mc').addEventListener('click', closeModal);
        veil.querySelector('#ms').addEventListener('click', async function () {
          var btn = veil.querySelector('#ms');
          var body = {
            name: veil.querySelector('#f_name').value.trim(),
            hostname: veil.querySelector('#f_host').value.trim().toLowerCase() || null,
            ns_domain: veil.querySelector('#f_ns').value.trim(),
            main_extension: veil.querySelector('#f_ext').value.trim() || null,
            brand_color: veil.querySelector('#f_color').value.trim() || null,
            support_email: veil.querySelector('#f_email').value.trim() || null,
            support_phone: veil.querySelector('#f_phone').value.trim() || null,
          };
          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            if (editing) await api('/tenants/' + t.id, { method: 'PATCH', body: body });
            else await api('/tenants', { method: 'POST', body: body });
            closeModal();
            panelTenants();
          } catch (err) {
            btn.disabled = false; btn.textContent = editing ? 'Save' : 'Create';
            formError(veil, err);
          }
        });
      });
  }

  async function toggleTenant(id, to) {
    var t = state.tenants.find(function (x) { return x.id === id; });
    if (to === 'suspended' &&
        !confirm('Suspend ' + t.name + '?\n\nTheir portal stops working immediately and ' +
                 'anyone signed in is cut off. Their data is kept and this can be undone.')) return;
    try {
      await api('/tenants/' + id + '/status', { method: 'POST', body: { status: to } });
      panelTenants();
    } catch (err) {
      alert(err.message);
    }
  }

  /* -------------------------------------------------------------- users */

  async function usersModal(t) {
    modal('Users — ' + t.name, t.hostname || 'shared portal',
      '<div class="empty">Loading…</div>', null, { wide: true });
    try {
      var d = await api('/tenants/' + t.id + '/users');
      var body =
        '<div class="alert form-err" hidden></div>' +
        (d.users.length
          ? '<div class="tscroll"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th>' +
            '<th>Last sign-in</th><th></th></tr></thead><tbody>' +
            d.users.map(function (u) {
              return '<tr><td>' + h(u.email) + '</td><td>' + pill(u.role) + '</td>' +
                '<td>' + pill(u.status) + '</td><td class="num">' + h(when(u.last_login_at)) + '</td>' +
                '<td class="actions">' +
                  (u.status === 'active'
                    ? '<button class="btn-ghost" data-view="' + h(u.id) + '" data-em="' + h(u.email) + '">View as</button>'
                    : '') +
                  '<button class="btn-ghost" data-reset="' + h(u.id) + '" data-em="' + h(u.email) + '">Reset</button>' +
                  '<button class="' + (u.status === 'active' ? 'btn-danger' : 'btn-ghost') +
                    '" data-toggle="' + h(u.id) + '" data-to="' +
                    (u.status === 'active' ? 'disabled' : 'active') + '">' +
                    (u.status === 'active' ? 'Disable' : 'Enable') + '</button>' +
                '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">No users yet.</div>') +
        '<div class="grid2" style="margin-top:16px">' +
          '<div class="field"><label for="nu_em">Add a user</label>' +
            '<input id="nu_em" type="email" placeholder="owner@acme.com"></div>' +
          '<div class="field"><label for="nu_role">Role</label>' +
            '<select id="nu_role"><option value="member">Member — view only</option>' +
            '<option value="admin">Admin — can change routing</option></select></div>' +
        '</div>' +
        '<div class="row-end"><button class="btn-ghost" id="mc">Close</button>' +
          '<button class="btn" id="madd">Add user</button></div>';

      modal('Users — ' + t.name, t.hostname || 'shared portal', body, function (veil) {
        veil.querySelector('#mc').addEventListener('click', closeModal);

        veil.querySelector('#madd').addEventListener('click', async function () {
          var email = veil.querySelector('#nu_em').value.trim();
          if (!email) return;
          try {
            var out = await api('/tenants/' + t.id + '/users', { method: 'POST', body: {
              email: email, role: veil.querySelector('#nu_role').value,
            }});
            showSecret('Password for ' + email, t.name, out.password);
          } catch (err) { formError(veil, err); }
        });

        veil.querySelectorAll('[data-view]').forEach(function (b) {
          b.addEventListener('click', async function () {
            if (!confirm('Open ' + t.name + "'s portal as " + b.dataset.em + '?\n\n' +
                         'You will see exactly what they see. The view is READ ONLY — ' +
                         'nothing can be changed — and it is recorded in their activity log.')) return;
            try {
              var out = await api('/users/' + b.dataset.view + '/impersonate', { method: 'POST' });
              // The grant lives for 60 seconds, so open it straight away.
              window.open(out.url, '_blank', 'noopener');
              closeModal();
              modal('Support view opened', out.email,
                '<p class="sub" style="margin-bottom:14px">A read-only view of ' + h(out.tenant) +
                "'s portal opened in a new tab. It ends by itself after " + h(out.minutes) +
                ' minutes, and the whole visit is in their activity log.</p>' +
                '<div class="row-end"><button class="btn" id="mc">Done</button></div>',
                function (v2) { v2.querySelector('#mc').addEventListener('click', closeModal); });
            } catch (err) { formError(veil, err); }
          });
        });

        veil.querySelectorAll('[data-reset]').forEach(function (b) {
          b.addEventListener('click', async function () {
            if (!confirm('Reset the password for ' + b.dataset.em +
                         '?\n\nThey will be signed out everywhere.')) return;
            try {
              var out = await api('/users/' + b.dataset.reset + '/password', { method: 'POST' });
              showSecret('New password for ' + b.dataset.em, t.name, out.password);
            } catch (err) { formError(veil, err); }
          });
        });

        veil.querySelectorAll('[data-toggle]').forEach(function (b) {
          b.addEventListener('click', async function () {
            try {
              await api('/users/' + b.dataset.toggle, { method: 'PATCH', body: { status: b.dataset.to } });
              usersModal(t);
            } catch (err) { formError(veil, err); }
          });
        });
      }, { wide: true });
    } catch (err) {
      modal('Users — ' + t.name, t.hostname,
        '<div class="alert alert-err">' + h(err.message) + '</div>' +
        '<div class="row-end"><button class="btn" id="mc">Close</button></div>',
        function (v) { v.querySelector('#mc').addEventListener('click', closeModal); });
    }
  }

  /* -------------------------------------------------------------- audit */

  var auditFilter = { tenantId: '', actorKind: '', result: '' };

  async function panelAudit() {
    panel().innerHTML =
      '<div class="card"><div class="card-head"><h2>Activity</h2></div>' +
        '<div class="filters">' +
          '<select id="fT"><option value="">All customers</option>' +
            state.tenants.map(function (t) {
              return '<option value="' + h(t.id) + '"' +
                (auditFilter.tenantId === t.id ? ' selected' : '') + '>' + h(t.name) + '</option>';
            }).join('') + '</select>' +
          '<select id="fK"><option value="">Anyone</option>' +
            '<option value="customer">Customers</option><option value="staff">Staff</option>' +
            '<option value="system">System</option></select>' +
          '<select id="fR"><option value="">Any result</option>' +
            '<option value="ok">Saved</option><option value="error">Failed</option>' +
            '<option value="denied">Refused</option></select>' +
        '</div>' +
        '<div id="auditBody"><div class="empty">Loading…</div></div>' +
      '</div>';

    ['fT', 'fK', 'fR'].forEach(function (id, i) {
      var el = document.getElementById(id);
      el.value = [auditFilter.tenantId, auditFilter.actorKind, auditFilter.result][i];
      el.addEventListener('change', function () {
        auditFilter = {
          tenantId: document.getElementById('fT').value,
          actorKind: document.getElementById('fK').value,
          result: document.getElementById('fR').value,
        };
        loadAudit();
      });
    });
    loadAudit();
  }

  async function loadAudit() {
    var host = document.getElementById('auditBody');
    var q = [];
    if (auditFilter.tenantId)  q.push('tenantId=' + encodeURIComponent(auditFilter.tenantId));
    if (auditFilter.actorKind) q.push('actorKind=' + encodeURIComponent(auditFilter.actorKind));
    if (auditFilter.result)    q.push('result=' + encodeURIComponent(auditFilter.result));
    q.push('limit=100');
    try {
      var d = await api('/audit?' + q.join('&'));
      host.innerHTML = auditTable(d.entries, true);
    } catch (err) {
      host.innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    }
  }

  function auditTable(rows, withCustomer) {
    if (!rows || !rows.length) return '<div class="empty">Nothing recorded.</div>';
    return '<div class="tscroll"><table><thead><tr><th>When</th>' +
      (withCustomer ? '<th>Customer</th>' : '') +
      '<th>Who</th><th>Action</th><th>Target</th><th>Result</th></tr></thead><tbody>' +
      rows.map(function (e) {
        return '<tr>' +
          '<td class="num">' + h(when(e.at)) + '</td>' +
          (withCustomer ? '<td>' + h(e.tenant_name || '—') + '</td>' : '') +
          '<td>' + h(e.actor_email || '—') +
            (e.actor_kind === 'staff' ? ' <span class="pill owner">staff</span>' : '') + '</td>' +
          '<td class="host">' + h(e.op) + '</td>' +
          '<td class="host">' + h(e.target || '—') + '</td>' +
          '<td>' + pill(e.result, e.result) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* -------------------------------------------------------------- staff */

  async function panelStaff() {
    panel().innerHTML = '<div class="empty">Loading…</div>';
    try {
      var d = await api('/staff');
      state.staff = d.staff;
      panel().innerHTML =
        '<div class="card"><div class="card-head"><h2>Operators</h2><div class="grow"></div>' +
          '<button class="btn" id="addS">Add operator</button></div>' +
          '<p class="desc">Anyone here can see and change every customer. Keep the list short.</p>' +
          '<div class="tscroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th>' +
          '<th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>' +
          d.staff.map(function (s) {
            var self = s.id === state.me.id;
            return '<tr><td>' + h(s.name) + (self ? ' <span class="pill member">you</span>' : '') + '</td>' +
              '<td>' + h(s.email) + '</td><td>' + pill(s.role) + '</td><td>' + pill(s.status) + '</td>' +
              '<td class="num">' + h(when(s.last_login_at)) + '</td>' +
              '<td class="actions">' + (self ? '' :
                '<button class="' + (s.status === 'active' ? 'btn-danger' : 'btn-ghost') +
                '" data-st="' + h(s.id) + '" data-to="' +
                (s.status === 'active' ? 'disabled' : 'active') + '">' +
                (s.status === 'active' ? 'Disable' : 'Enable') + '</button>') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>';

      document.getElementById('addS').addEventListener('click', function () { staffForm(); });
      panel().querySelectorAll('[data-st]').forEach(function (b) {
        b.addEventListener('click', async function () {
          try {
            await api('/staff/' + b.dataset.st, { method: 'PATCH', body: { status: b.dataset.to } });
            panelStaff();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      panel().innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    }
  }

  function staffForm() {
    modal('Add operator', 'They will be able to see and change every customer.',
      '<div class="alert form-err" hidden></div>' +
      '<div class="field"><label for="s_name">Name</label><input id="s_name"></div>' +
      '<div class="field"><label for="s_em">Email</label><input id="s_em" type="email"></div>' +
      '<div class="field"><label for="s_role">Role</label>' +
        '<select id="s_role"><option value="operator">Operator — manages customers</option>' +
        '<option value="owner">Owner — can also manage operators</option></select></div>' +
      '<div class="row-end"><button class="btn-ghost" id="mc">Cancel</button>' +
        '<button class="btn" id="ms">Create</button></div>',
      function (veil) {
        veil.querySelector('#mc').addEventListener('click', closeModal);
        veil.querySelector('#ms').addEventListener('click', async function () {
          try {
            var out = await api('/staff', { method: 'POST', body: {
              name: veil.querySelector('#s_name').value.trim(),
              email: veil.querySelector('#s_em').value.trim(),
              role: veil.querySelector('#s_role').value,
            }});
            showSecret('Password for ' + veil.querySelector('#s_em').value.trim(), 'New operator', out.password);
            panelStaff();
          } catch (err) { formError(veil, err); }
        });
      });
  }

  /* ------------------------------------------------------------- system */

// SkySwitch runs two separate API servers. They have different hosts and
// different credentials, so each is configured on its own.
  var SERVERS = [
    {
      id: 'pbx',
      title: 'PBX connection',
      blurb: 'The phone system itself — extensions, forwarding, devices, queues. ' +
             'Base address is your Branded Manager portal (https://portal.yourcompany.com) ' +
             'or https://&lt;resellerID&gt;-hpbx.dashmanager.com. The username and password ' +
             'are any Subscriber that can sign in to the Manager portal — that ' +
             'subscriber&rsquo;s scope decides what this portal can reach, so use one ' +
             'scoped no wider than it needs.',
      docs: 'pbx.readme.io',
      fields: [
        ['NS_BASE_URL',      'Base address',  'https://portal.yourcompany.com', false],
        ['NS_CLIENT_ID',     'Client ID',     '',  false],
        ['NS_CLIENT_SECRET', 'Client secret', '',  true],
        ['NS_USERNAME',      'API username',  '',  false],
        ['NS_PASSWORD',      'API password',  '',  true],
      ],
    },
    {
      id: 'telco',
      title: 'Telco connection',
      blurb: 'Phone numbers, porting, e911 and billing. Separate credentials from ' +
             'the PBX — request a client ID and secret from SkySwitch Control Tower. ' +
             'Scopes are requested by us, so list only what this portal needs: a token ' +
             'that never asks for billing or back_office cannot reach them.',
      docs: 'developers.skyswitch.com',
      fields: [
        ['TELCO_BASE_URL',      'Base address',   'https://api.skyswitch.com', false],
        ['TELCO_AUTH_STYLE',    'Sign-in method', 'oauth2', false],
        ['TELCO_TOKEN_PATH',    'Token path',     '/oauth/token', false],
        ['TELCO_SCOPES',        'Scopes',         'phone_number routing e911', false],
        ['TELCO_CLIENT_ID',     'Client ID',      '',  false],
        ['TELCO_CLIENT_SECRET', 'Client secret',  '',  true],
        ['TELCO_USERNAME',      'API username',   '',  false],
        ['TELCO_PASSWORD',      'API password',   '',  true],
        ['TELCO_API_KEY',       'API key',        'only for the bearer method', true],
      ],
    },
  ];

  async function panelSystem() {
    panel().innerHTML = '<div class="empty">Loading…</div>';
    try {
      var fetched = await Promise.all(
        [api('/health')].concat(SERVERS.map(function (sv) { return api('/settings/' + sv.id); })));
      var health = fetched[0];

      panel().innerHTML =
        '<div class="stats">' +
          stat('Database', health.db === 'up' ? 'Up' : 'Down', health.db !== 'up') +
          stat('PBX',   health.pbx   === 'configured' ? 'Connected' : 'Not set up', health.pbx   !== 'configured') +
          stat('Telco', health.telco === 'configured' ? 'Connected' : 'Not set up', health.telco !== 'configured') +
          stat('Uptime', formatUptime(health.uptimeSeconds)) +
        '</div>' +
        SERVERS.map(function (sv, i) {
          return serverCard(sv, fetched[i + 1].settings);
        }).join('') +
        '<div class="card"><h2>Notes</h2>' +
          '<p class="desc" style="margin:0">Secrets are encrypted before they are stored, and are ' +
          'never shown again once saved &mdash; leave a password field blank to keep the current one. ' +
          'Values set here override anything in <code style="font-family:var(--mono)">/etc/portal/portal.env</code>, ' +
          'and take effect immediately without a restart.</p>' +
        '</div>';

      SERVERS.forEach(function (sv) {
        document.getElementById('save_' + sv.id).addEventListener('click', function () { saveServer(sv); });
        document.getElementById('test_' + sv.id).addEventListener('click', function () { testServer(sv); });
      });
    } catch (err) {
      panel().innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    }
  }

  function serverCard(sv, settings) {
    return '<div class="card">' +
      '<div class="card-head"><h2>' + h(sv.title) + '</h2>' +
        '<div class="grow"></div>' +
        '<span class="host" style="font-size:11px">' + h(sv.docs) + '</span></div>' +
      '<p class="desc">' + sv.blurb + '</p>' +
      '<div class="alert form-err" id="err_' + sv.id + '" hidden></div>' +
      sv.fields.map(function (f) {
        var key = f[0], label = f[1], ph = f[2], secret = f[3];
        var info = settings[key] || {};
        var origin = info.source === 'console' ? 'saved here'
                   : info.source === 'file' ? 'from portal.env' : 'not set';
        return '<div class="field">' +
          '<label for="s_' + key + '">' + h(label) +
            ' <span style="opacity:.6;font-weight:400">&mdash; ' + h(origin) + '</span></label>' +
          '<input id="s_' + key + '" type="' + (secret ? 'password' : 'text') + '" ' +
            'autocomplete="new-password" placeholder="' +
            h(secret && info.set ? '•••••••• (leave blank to keep)' : ph) + '" ' +
            'value="' + h(secret ? '' : (info.value || '')) + '">' +
        '</div>';
      }).join('') +
      '<div class="row-end">' +
        '<button class="btn-ghost" id="test_' + sv.id + '">Test connection</button>' +
        '<button class="btn" id="save_' + sv.id + '">Save</button>' +
      '</div>' +
      '<div id="res_' + sv.id + '" style="margin-top:12px"></div>' +
    '</div>';
  }

  function formatUptime(sec) {
    if (sec == null) return '—';
    if (sec < 3600) return Math.round(sec / 60) + ' min';
    if (sec < 86400) return Math.round(sec / 3600) + ' hr';
    return Math.round(sec / 86400) + ' days';
  }

  function formValues(sv) {
    var body = {};
    sv.fields.forEach(function (f) {
      var el = document.getElementById('s_' + f[0]);
      if (!el) return;
      var v = el.value.trim();
      // A blank secret means "keep what is stored", so do not send the key at
      // all — sending "" would clear it.
      if (f[3] && v === '') return;
      body[f[0]] = v;
    });
    return body;
  }

  async function saveServer(sv) {
    var btn = document.getElementById('save_' + sv.id);
    var out = document.getElementById('res_' + sv.id);
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/settings/' + sv.id, { method: 'PUT', body: formValues(sv) });
      out.innerHTML = '<div class="alert alert-ok">Saved. Testing the connection…</div>';
      await testServer(sv);
      panelSystem();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      out.innerHTML = '<div class="alert alert-err">' + h(err.message) +
        (err.details ? ': ' + h(err.details.map(function (d) { return d.field + ' ' + d.problem; }).join('; ')) : '') +
        '</div>';
    }
  }

  async function testServer(sv) {
    var btn = document.getElementById('test_' + sv.id);
    var out = document.getElementById('res_' + sv.id);
    if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
    try {
      var r = await api('/settings/' + sv.id + '/test', { method: 'POST' });
      out.innerHTML = r.ok
        ? '<div class="alert alert-ok">Connected. ' + h(r.detail || 'SkySwitch accepted these credentials.') + '</div>'
        : '<div class="alert alert-err">' +
          (r.reason === 'not_configured'
            ? 'Not set up yet — still missing: ' + h((r.missing || []).join(', '))
            : 'SkySwitch refused the connection. ' + h(r.detail || '')) +
          '</div>';
    } catch (err) {
      out.innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Test connection'; }
    }
  }

  /* -------------------------------------------------------------- start */

  (async function start() {
    try {
      state.me = await api('/me');
      state.csrf = state.me.csrfToken;
      renderApp();
    } catch (err) {
      renderLogin();
    }
  })();
})();
