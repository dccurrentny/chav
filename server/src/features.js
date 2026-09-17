// What a customer's portal offers.
//
// Customers do not all want the same thing: one needs to change their
// forwarding, another only to see who is on which extension, a third wants
// the weekly schedule. So a portal is assembled per customer from this
// catalogue rather than every customer getting every screen.
//
// Each feature names the operations it permits. That is the enforcement: an
// operation is refused unless some enabled feature covers it, so turning a
// feature off actually closes the API rather than only hiding a button.

export const FEATURES = Object.freeze({
  forwarding_view: {
    label: 'See where calls go',
    blurb: 'Read the forwarding rules on their main line.',
    operations: ['answerrule.list'],
  },
  forwarding_edit: {
    label: 'Change where calls go',
    blurb: 'Add, change, reorder and remove forwarding rules.',
    // Editing is meaningless without being able to see the rules first.
    requires: ['forwarding_view'],
    operations: [
      'answerrule.update', 'answerrule.create',
      'answerrule.delete', 'answerrule.reorder',
    ],
  },
  timeframes: {
    label: 'Time periods',
    blurb: 'See the time frames their rules can refer to.',
    operations: ['timeframe.list'],
  },
  extensions: {
    label: 'Extensions and phones',
    blurb: 'See who is on which extension and which handsets are registered.',
    operations: ['subscriber.list', 'device.list'],
  },
  queues: {
    label: 'Call queues',
    blurb: 'See the call queues on their account.',
    operations: ['callqueue.list'],
  },
  schedule: {
    label: 'Dispatch schedule',
    blurb: 'Set who answers the phone in each hour of the week, and have it ' +
           'applied automatically as the hours turn.',
    // The schedule writes forwarding, so it needs the rule operations. It does
    // not need forwarding_edit: a customer can be given the schedule without
    // being given free rein over individual rules.
    operations: ['answerrule.list', 'answerrule.update', 'answerrule.create'],
  },
  history: {
    label: 'Activity history',
    blurb: 'See what has been changed on their account, and by whom.',
    // Served from our own audit log, so it needs no SkySwitch operation.
    operations: [],
  },
});

export const FEATURE_NAMES = Object.freeze(Object.keys(FEATURES));

// A sensible starting point for a new customer: see their routing and what
// has been done to it, but not change anything until someone decides so.
export const DEFAULT_FEATURES = Object.freeze(['forwarding_view', 'history']);

export function isFeature(name) {
  return Object.hasOwn(FEATURES, name);
}

/** Add anything the requested features depend on. */
export function withDependencies(names) {
  const out = new Set();
  for (const name of names) {
    if (!isFeature(name)) continue;
    out.add(name);
    for (const dep of FEATURES[name].requires ?? []) out.add(dep);
  }
  return [...out];
}

/** Every operation the given features permit. */
export function operationsFor(names) {
  const ops = new Set();
  for (const name of names) {
    if (!isFeature(name)) continue;
    for (const op of FEATURES[name].operations) ops.add(op);
  }
  return ops;
}

/** Which feature would have to be on for this operation. Null if none covers it. */
export function featureForOperation(operation) {
  for (const [name, f] of Object.entries(FEATURES)) {
    if (f.operations.includes(operation)) return name;
  }
  return null;
}
