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
const e164ish   = z.string().regex(/^\+?\d{7,15}$/, 'not a valid phone number');

export const OPERATIONS = {
  // ---------- Answer rules (the routing the Scheduler Suite writes) ----------
  'answerrule.list': {
    server: 'pbx',
    object: 'answerrule',
    action: 'read',
    write: false,
    role: 'member',
    params: z.object({ extension }).strict(),
  },

  'answerrule.update': {
    server: 'pbx',
    object: 'answerrule',
    action: 'update',
    write: true,
    role: 'admin',
    params: z.object({
      extension,
      // NetSapiens names this field `time_frame`; keep its wire name.
      time_frame:   z.string().min(1).max(64),
      forward_destination: e164ish.or(extension),
      forward_enable: z.enum(['yes', 'no']).default('yes'),
      order:        z.coerce.number().int().min(0).max(999).optional(),
    }).strict(),
    readBack: { op: 'answerrule.list', key: 'extension' },
    describe: (p) => `${p.extension} ${p.time_frame} -> ${p.forward_destination}`,
  },

  'answerrule.create': {
    server: 'pbx',
    object: 'answerrule',
    action: 'create',
    write: true,
    role: 'admin',
    params: z.object({
      extension,
      time_frame:   z.string().min(1).max(64),
      forward_destination: e164ish.or(extension),
      forward_enable: z.enum(['yes', 'no']).default('yes'),
      order:        z.coerce.number().int().min(0).max(999).optional(),
    }).strict(),
    readBack: { op: 'answerrule.list', key: 'extension' },
    describe: (p) => `${p.extension} ${p.time_frame} -> ${p.forward_destination}`,
  },

  'answerrule.delete': {
    server: 'pbx',
    object: 'answerrule',
    action: 'delete',
    write: true,
    role: 'admin',
    params: z.object({ extension, time_frame: z.string().min(1).max(64) }).strict(),
    readBack: { op: 'answerrule.list', key: 'extension' },
    describe: (p) => `${p.extension} ${p.time_frame}`,
  },

  // Answer rules are evaluated in order, so reordering changes which one wins.
  // Listed in the SkySwitch PBX reference alongside the other answerrule calls.
  'answerrule.reorder': {
    server: 'pbx',
    object: 'answerrule',
    action: 'reorder',
    write: true,
    role: 'admin',
    params: z.object({
      extension,
      time_frame: z.string().min(1).max(64),
      order: z.coerce.number().int().min(0).max(999),
    }).strict(),
    readBack: { op: 'answerrule.list', key: 'extension' },
    describe: (p) => `${p.extension} ${p.time_frame} -> position ${p.order}`,
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
    params: z.object({ extension: extension.optional() }).strict(),
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
