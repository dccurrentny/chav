import express from 'express';
import { lookupByHostname, isReservedHostname } from '../tenant.js';

export const brandingRouter = express.Router();

// Public, pre-login: the sign-in screen has to be branded before anyone has
// authenticated. Returns only what is safe to show a stranger who typed the
// hostname — never the NetSapiens domain, never anything about other tenants.
brandingRouter.get('/branding', (req, res) => {
  // The shared portal belongs to the provider. It must not wear a customer's
  // name — before sign-in there is no customer, and guessing would show one
  // customer's branding to another.
  if (req.sharedPortal) {
    return res.json({
      name: 'Phone Settings',
      color: null, logoUrl: null,
      supportEmail: null, supportPhone: null,
      shared: true,
    });
  }

  const t = req.tenant;
  if (!t || t.status !== 'active') {
    return res.status(404).json({ error: 'unknown_portal', message: 'This address is not an active portal.' });
  }
  res.json({
    name:         t.brand_name || t.name,
    color:        t.brand_color || null,
    logoUrl:      t.logo_url || null,
    supportEmail: t.support_email || null,
    supportPhone: t.support_phone || null,
  });
});

// Caddy's on-demand TLS gate. Caddy calls this before requesting a
// certificate for a hostname it has never seen.
//
// Without it, anyone who points a DNS record at this droplet makes us request
// a certificate on their behalf — which burns Let's Encrypt rate limits and
// lets a stranger mint certs against our IP. Only hostnames belonging to an
// active tenant get a yes.
//
// Reachable from loopback only: the app binds 127.0.0.1 and Caddy does not
// proxy /internal/* from the public site block.
export const internalRouter = express.Router();

internalRouter.get('/internal/tls-check', async (req, res) => {
  const domain = String(req.query.domain ?? '');
  if (!domain) return res.status(400).send('missing domain');

  // The shared portal and the staff console are ours and have no tenant row.
  if (isReservedHostname(domain)) return res.status(200).send('ok');

  const tenant = await lookupByHostname(domain);
  if (tenant && tenant.status === 'active') return res.status(200).send('ok');
  return res.status(404).send('unknown host');
});
