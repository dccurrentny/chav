// Customer portal SPA.
//
// One build serves every customer. Which customer this is comes from the
// hostname, resolved server-side — the frontend never sends a tenant id and
// could not pick a different one if it tried.
(function () {
  'use strict';

  var state = { brand: null, me: null, csrf: null, rules: [], history: [] };



  var boot = document.getElementById('boot');
  var root = document.getElementById('root');

  // ---------- helpers ----------

  function h(html) {
    // Single escape point for anything that came from the server or a person.
    return String(html)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w[0]; }).join('').toUpperCase();
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
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (_) { /* empty body is fine */ }
    if (!res.ok) {
      var err = new Error((data && data.message) || 'Something went wrong.');
      err.code = data && data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Applies the customer's accent. Everything else is identical per tenant.
  function applyBrand(brand) {
    document.title = (brand.name ? brand.name + ' — ' : '') + 'Phone Settings';
    if (brand.color) {
      var r = document.documentElement.style;
      r.setProperty('--accent', brand.color);
      r.setProperty('--accent-soft', hexToSoft(brand.color));
      r.setProperty('--accent-ink', contrastInk(brand.color));
    }
  }

  function hexToSoft(hex) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',0.11)';
  }

  // Pick black or white text for the accent, so a pale brand colour does not
  // produce an unreadable button.
  function contrastInk(hex) {
    var n = parseInt(hex.slice(1), 16);
    var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return L > 0.45 ? '#101828' : '#FFFFFF';
  }

  function logoMarkup(brand, cls) {
    if (brand.logoUrl) {
      return '<img class="logo ' + (cls || '') + '" src="' + h(brand.logoUrl) +
             '" alt="' + h(brand.name) + '">';
    }
    return '<div class="logo ' + (cls || '') + '">' + h(initials(brand.name)) + '</div>';
  }

  function supportMarkup(brand) {
    var bits = [];
    if (brand.supportEmail) bits.push('<a href="mailto:' + h(brand.supportEmail) + '">' + h(brand.supportEmail) + '</a>');
    if (brand.supportPhone) bits.push('<a href="tel:' + h(brand.supportPhone) + '">' + h(brand.supportPhone) + '</a>');
    if (!bits.length) return '';
    return '<div class="support">Need help? ' + bits.join(' &middot; ') + '</div>';
  }

  // ---------- screens ----------

  function renderUnknownPortal() {
    boot.hidden = true;
    root.hidden = false;
    root.innerHTML =
      '<div class="login-shell"><div class="login"><div class="card">' +
        '<div class="login-head"><h1>Portal not found</h1>' +
        '<p>This web address is not set up as a phone portal. Check the link you were given.</p></div>' +
      '</div></div></div>';
  }

  function renderLogin(message) {
    boot.hidden = true;
    root.hidden = false;
    var b = state.brand;
    root.innerHTML =
      '<div class="login-shell"><div class="login">' +
        '<div class="login-head">' + logoMarkup(b) +
          '<h1>' + h(b.name) + '</h1><p>' +
          (b.shared ? 'Sign in with your account email' : 'Phone settings') + '</p></div>' +
        '<div class="card">' +
          (message ? '<div class="alert alert-err">' + h(message) + '</div>' : '') +
          '<form id="loginForm" novalidate>' +
            '<div class="field"><label for="email">Email</label>' +
              '<input id="email" name="email" type="email" autocomplete="username" required></div>' +
            '<div class="field"><label for="password">Password</label>' +
              '<input id="password" name="password" type="password" autocomplete="current-password" required></div>' +
            '<button class="btn" id="loginBtn" type="submit" style="width:100%">Sign in</button>' +
          '</form>' +
        '</div>' +
        supportMarkup(b) +
      '</div></div>';

    document.getElementById('loginForm').addEventListener('submit', onLogin);
  }

  async function onLogin(evt) {
    evt.preventDefault();
    var btn = document.getElementById('loginBtn');
    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      var out = await api('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
      state.csrf = out.csrfToken;
      await loadSession();
      await renderApp();
    } catch (err) {
      renderLogin(err.message);
    }
  }

  async function loadSession() {
    state.me = await api('/api/auth/me');
    state.csrf = state.me.csrfToken;
  }

  async function renderApp() {
    boot.hidden = true;
    root.hidden = false;
    var b = state.brand, me = state.me;

    renderSupportBar(me.impersonation);

    root.innerHTML =
      '<div class="wrap">' +
        '<div class="topbar">' + logoMarkup(b) +
          '<div><div class="brandname">' + h(b.name) + '</div>' +
          '<div class="brandsub">Phone settings</div></div>' +
          '<div class="grow"></div>' +
          '<div class="whoami"><b>' + h(me.email || 'Support') + '</b>' +
            (me.role === 'admin' ? 'Can make changes' : 'View only') + '</div>' +
          '<button class="btn-ghost btn-sm" id="signOut">Sign out</button>' +
        '</div>' +

        '<h1>Where your calls go</h1>' +
        '<p class="lede">These are the forwarding rules on your main line. ' +
          (me.impersonation
            ? 'You are in this account as support. Changes you make are recorded against your name.'
            : me.role === 'admin'
              ? 'Changes take effect on your phone system straight away.'
              : 'Your account can view these but not change them — ask an administrator on your account.') +
        '</p>' +

        '<div class="card"><h2>Forwarding rules</h2>' +
          '<p class="desc">Each rule says where calls go during a particular time period.</p>' +
          '<div id="rules"><div class="empty">Loading…</div></div>' +
        '</div>' +

        '<div class="card"><h2>Recent changes</h2>' +
          '<p class="desc">Everything done through this portal, most recent first.</p>' +
          '<div class="hist-scroll" id="history"><div class="empty">Loading…</div></div>' +
        '</div>' +

        supportMarkup(b) +
      '</div>';

    document.getElementById('signOut').addEventListener('click', onSignOut);
    loadRules();
    loadHistory();
  }

  // Shown for the whole life of a support session, with a live countdown so
  // it is obvious the view expires on its own.
  function renderSupportBar(imp) {
    var existing = document.querySelector('.supportbar');
    if (existing) existing.remove();
    if (!imp) { document.body.classList.remove('supporting'); return; }

    document.body.classList.add('supporting');
    var bar = document.createElement('div');
    bar.className = 'supportbar';
    bar.setAttribute('role', 'status');
    // Says plainly that changes are possible and who they will be recorded
    // against. A banner claiming "read only" while writes went through would
    // be worse than no banner.
    var who = imp.preview
      ? 'no customer account &mdash; setup preview'
      : 'signed in as ' + h(state.me.email);
    bar.innerHTML =
      '<span class="dot" aria-hidden="true"></span>' +
      '<span>Support session &mdash; <b>' + h(imp.by) + '</b>, ' + who + '. ' +
        '<b>Changes are logged as theirs.</b></span>' +
      '<span class="grow"></span>' +
      '<span class="left" id="sbLeft"></span>' +
      '<button type="button" id="sbExit">Leave support view</button>';
    document.body.insertBefore(bar, document.body.firstChild);

    document.getElementById('sbExit').addEventListener('click', onSignOut);

    var until = new Date(imp.expiresAt).getTime();
    function tick() {
      var left = Math.max(0, Math.round((until - Date.now()) / 1000));
      var el = document.getElementById('sbLeft');
      if (!el) return;
      if (left === 0) { el.textContent = 'expired'; onSignOut(); return; }
      el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left';
      setTimeout(tick, 1000);
    }
    tick();
  }

  async function onSignOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* sign out anyway */ }
    state.me = null;
    state.csrf = null;
    renderSupportBar(null);
    renderLogin();
  }

  async function loadRules() {
    var host = document.getElementById('rules');
    var ext = state.me.tenant.mainExtension;

    // Never fall back to a default: a wrong extension would show one customer
    // another customer's line, which is worse than showing nothing.
    if (!ext) {
      host.innerHTML = '<div class="alert alert-warn">Your provider has not finished ' +
        'setting this up yet. Get in touch and they can point this page at your main line.</div>';
      return;
    }

    try {
      // `user` is the API's name for the extension the rules belong to.
      // `user` is the API's name for the extension the rules belong to.
      var out = await api('/api/ns/answerrule.list', { method: 'POST', body: { user: ext } });
      var rules = normaliseRules(out.data);
      state.rules = rules;
      host.innerHTML = rules.length ? rules.map(ruleRow).join('') :
        '<div class="empty">No forwarding rules are set on this line.</div>';
    } catch (err) {
      // The honest distinction: our fault vs the phone system being unreachable.
      var cls = err.code === 'upstream_failed' ? 'alert-warn' : 'alert-err';
      host.innerHTML = '<div class="alert ' + cls + '">' + h(err.message) + '</div>';
    }
  }

  // NetSapiens answers in more than one shape depending on the action; accept
  // an array, a single object, or an empty body without breaking the page.
  function normaliseRules(data) {
    if (!data) return [];
    var list = Array.isArray(data) ? data : (Array.isArray(data.answerrule) ? data.answerrule : [data]);
    return list.filter(function (r) { return r && r.time_frame; });
  }

  // A rule can forward in several ways at once. Show the one that is actually
  // switched on, in the order a dispatcher would care about.
  function activeDestination(r) {
    var modes = [
      ['for', 'Forwarded'],
      ['sim', 'Rings at'],
      ['fna', 'If no answer'],
      ['fbu', 'If busy'],
      ['fnr', 'If unreachable'],
      ['foa', 'If on a call'],
    ];
    for (var i = 0; i < modes.length; i++) {
      var key = modes[i][0];
      if (String(r[key + '_control'] || '').toLowerCase() === 'e' && r[key + '_parameters']) {
        return { label: modes[i][1], to: r[key + '_parameters'] };
      }
    }
    if (String(r.dnd_control || '').toLowerCase() === 'e') {
      return { label: 'Do not disturb', to: 'calls are not put through' };
    }
    return null;
  }

  function ruleRow(r) {
    var when = r.time_frame || 'Always';
    var active = activeDestination(r);
    var to = active ? active.to : 'no forwarding set';
    var lead = active ? active.label : 'Calls go to';
    var on = String(r.enable || 'yes').toLowerCase() === 'yes';
    return '<div class="rule"><div>' +
             '<div class="rule-when">' + h(when) + '</div>' +
             '<div class="rule-to num">' + h(lead) + ' ' + h(to) + '</div>' +
           '</div>' +
           '<span class="badge' + (on ? '' : ' off') + '">' + (on ? 'Active' : 'Off') + '</span>' +
           '</div>';
  }

  async function loadHistory() {
    var host = document.getElementById('history');
    try {
      var out = await api('/api/audit?limit=25');
      var rows = out.entries || [];
      if (!rows.length) {
        host.innerHTML = '<div class="empty">Nothing has been changed yet.</div>';
        return;
      }
      host.innerHTML =
        '<table class="hist"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Result</th></tr></thead><tbody>' +
        rows.map(function (e) {
          var when = new Date(e.at);
          return '<tr>' +
            '<td class="num">' + h(when.toLocaleString()) + '</td>' +
            '<td>' + h(e.actor_email || '—') +
              (e.actor_kind === 'staff' ? ' <span style="opacity:.7">(support)</span>' : '') + '</td>' +
            '<td>' + h(describeOp(e)) + '</td>' +
            '<td class="r-' + h(e.result) + '">' + h(e.result === 'ok' ? 'Saved' : e.result === 'denied' ? 'Not allowed' : 'Failed') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    } catch (err) {
      host.innerHTML = '<div class="alert alert-err">' + h(err.message) + '</div>';
    }
  }

  // Operation names are built for the API; customers get plain words.
  function describeOp(e) {
    var map = {
      'answerrule.update': 'Changed forwarding',
      'answerrule.create': 'Added a forwarding rule',
      'answerrule.delete': 'Removed a forwarding rule',
      'answerrule.list':   'Viewed forwarding',
      'timeframe.list':    'Viewed time periods',
      'subscriber.list':   'Viewed extensions',
      'device.list':       'Viewed phones',
      'callqueue.list':    'Viewed queues',
      'impersonation.begin':         'Support opened a view of this account',
      'impersonation.write_refused': 'Support tried to change something (blocked)',
      'staff.impersonate.start':     'Support opened a view of this account',
      'staff.tenant.create':         'Account set up',
      'staff.tenant.update':         'Account details changed',
      'staff.tenant.status':         'Account status changed',
      'staff.user.create':           'User added',
      'staff.user.update':           'User changed',
      'staff.user.reset_password':   'Password reset',
    };
    var label = map[e.op] || e.op;
    return e.target ? label + ' (' + e.target + ')' : label;
  }

  // ---------- start ----------

  (async function start() {
    try {
      state.brand = await api('/api/branding');
    } catch (err) {
      return renderUnknownPortal();
    }
    applyBrand(state.brand);

    try {
      await loadSession();
      await renderApp();
    } catch (err) {
      renderLogin();
    }
  })();
})();
