// The operation allowlist.
//
// This file IS the authorization boundary for SkySwitch. Anything not listed
// here cannot be invoked by a customer, whatever they put in the request.
// Default deny: routes.js looks an operation up by name and 404s on a miss.
//
// Every entry names the SkySwitch server it belongs to. There are two, and
// they are not interchangeable:
//
//   server: 'pbx'   — NetSapiens, /ns-api/. Extensions, answer rules, devices.
//   server: 'telco' — SkySwitch's reseller API. Numbers, porting, e911, billing.
//
// A 'pbx' entry uses object/action; a 'telco' entry uses method/path. Routing
// a call to the wrong server is the mistake this field exists to prevent.
//
// Field names below follow SkySwitch's published OpenAPI definition for each
// call, not what they ought to be called. They are terse and inconsistent
// (`user` for an extension, `for_parameters` for a forwarding destination,
// "e"/"d" rather than true/false) and copying them exactly is the point — the
// portal translates for the customer, the wire format stays as documented.
//
// Rules for every entry:
//   - `params` validates and STRIPS unknown keys (zod .strict() would throw;
//     we want a hard error, so .strict() is deliberate).
//   - `domain` is NEVER declared here. routes.js injects it from the session.
//   - `write: true` marks an operation that changes state; those are audited
//     with before/after and are subject to the stricter rate limit.
//   - `readBack` names the read operation used to confirm a write landed,
//     because a 200 from NetSapiens does not reliably mean the change applied.
import { z } from 'zod';

// Extensions are 3-6 digits at DC Current; widen if your dial plan differs.
const extension = z.string().regex(/^\d{3,6}$/, 'extension must be 3-6 digits');

// A destination list is space-separated and mixes devices, extensions and
// external numbers — the documented example is "100 100a 14074887578".
const destinations = z.string()
  .regex(/^[0-9a-zA-Z][0-9a-zA-Z @._-]{0,199}$/, 'not a valid destination list');

// Every feature toggle on an answer rule is "e" for enable or "d" for disable.
const control = z.enum(['e', 'd'], {
  errorMap: () => ({ message: 'must be "e" (enable) or "d" (disable)' }),
});

// A time frame name, or "*" for always.
const timeFrame = z.string().min(1).max(64);

// The forwarding modes an answer rule can carry. Each is a destination list
// plus its own enable flag, and all are optional: a rule sets the ones it uses.
const forwardingModes = {
  sim_parameters: destinations.optional(),   // simultaneous ring
  sim_control:    control.optional(),
  for_parameters: destinations.optional(),   // forward always
  for_control:    control.optional(),
  fbu_parameters: destinations.optional(),   // forward when busy
  fbu_control:    control.optional(),
  fna_parameters: destinations.optional(),   // forward when no answer
  fna_control:    control.optional(),
  fnr_parameters: destinations.optional(),   // forward when not registered
  fnr_control:    control.optional(),
  foa_parameters: destinations.optional(),   // forward when on an active call
  foa_control:    control.optional(),
  dnd_control:    control.optional(),        // do not disturb
};

// Shared by create and update: the rule's identity and its state.
const answerRuleBase = {
  // Named `user` by the API. It is the extension the rule belongs to.
  user: extension,
  time_frame: timeFrame,
  order: z.coerce.number().int().min(0).max(999),
  enable: z.enum(['yes', 'no']),
  ...forwardingModes,
};

function describeRule(p) {
  const dest = p.for_parameters || p.sim_parameters || p.fna_parameters || p.fbu_parameters;
  return `${p.user} ${p.time_frame}${dest ? ` -> ${dest}` : ''}`;
}

export const OPERATIONS = {
  // ---------- Answer rules (the routing the Scheduler Suite writes) ----------
  'answerrule.list': {
    server: 'pbx',
    object: 'answerrule',
    action: 'read',
    write: false,
    role: 'member',
    params: z.object({ user: extension }).strict(),
  },

  // Field names and requiredness taken from the published OpenAPI definition
  // for object=answerrule&action=update.
  'answerrule.update': {
    server: 'pbx',
    object: 'answerrule',
    action: 'update',
    write: true,
    role: 'admin',
    params: z.object(answerRuleBase).strict(),
    readBack: { op: 'answerrule.list', key: 'user' },
    describe: describeRule,
  },

  'answerrule.create': {
    server: 'pbx',
    object: 'answerrule',
    action: 'create',
    write: true,
    role: 'admin',
    params: z.object(answerRuleBase).strict(),
    readBack: { op: 'answerrule.list', key: 'user' },
    describe: describeRule,
  },

  'answerrule.delete': {
    server: 'pbx',
    object: 'answerrule',
    action: 'delete',
    write: true,
    role: 'admin',
    params: z.object({ user: extension, time_frame: timeFrame }).strict(),
    readBack: { op: 'answerrule.list', key: 'user' },
    describe: (p) => `${p.user} ${p.time_frame}`,
  },

  // Rules are evaluated in order, so reordering changes which one wins.
  'answerrule.reorder': {
    server: 'pbx',
    object: 'answerrule',
    action: 'reorder',
    write: true,
    role: 'admin',
    params: z.object({
      user: extension,
      time_frame: timeFrame,
      order: z.coerce.number().int().min(0).max(999),
    }).strict(),
    readBack: { op: 'answerrule.list', key: 'user' },
    describe: (p) => `${p.user} ${p.time_frame} -> position ${p.order}`,
  },

  // ---------- Time frames ----------
  'timeframe.list': {
    server: 'pbx',
    object: 'timeframe',
    action: 'read',
    write: false,
    role: 'member',
    params: z.object({}).strict(),
  },

  // ---------- Read-only inventory ----------
  'subscriber.list': {
    server: 'pbx',
    object: 'subscriber',
    action: 'read',
    write: false,
    role: 'member',
    params: z.object({}).strict(),
  },

  'device.list': {
    server: 'pbx',
    object: 'device',
    action: 'read',
    write: false,
    role: 'member',
    params: z.object({ user: extension.optional() }).strict(),
  },

  'callqueue.list': {
    server: 'pbx',
    object: 'callqueue',
    action: 'read',
    write: false,
    role: 'member',
    params: z.object({}).strict(),
  },
};

// Operations for the Telco server go here as they are defined. Each needs a
// verified method and path from the SkySwitch Telco API reference; none are
// declared yet because guessing an endpoint that provisions phone numbers or
// changes billing is not a guess worth making.

export function getOperation(name) {
  // Reject prototype-chain lookups ('constructor', '__proto__', ...).
  return Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : null;
}

export const OPERATION_NAMES = Object.keys(OPERATIONS);
