// Two layers, on purpose.
//
// SIGNALS is the fine-grained vocabulary the model reports in. Narrow, concrete
// ids extract better than broad ones — "was a one-time code asked for" is a
// question Nova can answer, "is this an access problem" is not.
//
// FAMILIES is what the rest of the system counts and what the judge view shows.
// Nova is inconsistent about which neighbouring label it picks for the same
// sentence: "move everything to a safe account" comes back as unusual_payment on
// one run and verification_bypass on the next. Collapsing to families absorbs
// that, and stops two near-synonymous labels for one sentence scoring twice.
//
// Weights live on the family, so a family costs the same however it was spotted.
// 2 = notable, 3 = strong. Nothing scores 1: a family is worth noticing or it is
// not in the list.

export const FAMILIES = {
  identity: {
    weight: 2,
    label: 'Identity / impersonation',
    blurb: 'A stranger made contact, or claims to be someone they may not be.',
  },
  pressure: {
    weight: 2,
    label: 'Urgency / pressure',
    blurb: 'The user is being hurried, frightened, or tempted into acting.',
  },
  verification: {
    weight: 2,
    label: 'Verification avoidance',
    blurb: 'The user is being steered away from checking independently.',
  },
  secrecy: {
    weight: 3,
    label: 'Secrecy / isolation',
    blurb: 'The user is being told to keep it to themselves.',
  },
  money: {
    weight: 3,
    label: 'Money / unusual payment',
    blurb: 'Someone else is directing where the user’s money goes.',
  },
  access: {
    weight: 3,
    label: 'Device / account access',
    blurb: 'Someone is asking for the keys — a device, a code, an account.',
  },
};

export const SIGNALS = {
  unsolicited_contact: {
    family: 'identity',
    hint: 'Someone contacted the user out of the blue (call, text, email, DM, pop-up).',
  },
  impersonation_authority: {
    family: 'identity',
    hint: 'The other party claims to be a bank, government body, police, tech support, a well-known company, or a family member.',
  },
  urgency_pressure: {
    family: 'pressure',
    hint: 'The user quotes a deadline or a push to act at once — "it has to be today", "before it is too late", "the account will be closed". A request on its own is not urgency.',
  },
  emotional_manipulation: {
    family: 'pressure',
    hint: 'Fear, threats, romance, or a relative supposedly in trouble is being used to move the user.',
  },
  too_good_offer: {
    family: 'pressure',
    hint: 'A prize, refund, windfall, or guaranteed investment return is on the table.',
  },
  verification_bypass: {
    family: 'verification',
    hint: 'The user is relying on contact details the other party supplied, or is being steered away from calling the organisation back on an official number.',
  },
  secrecy_isolation: {
    family: 'secrecy',
    hint: 'The user is told to keep it quiet, not tell family, or not mention it to bank staff.',
  },
  unusual_payment: {
    family: 'money',
    hint: 'Someone else is directing the user to part with money in a way that cannot be undone: moving savings to a "safe account", transferring or wiring funds, buying cryptocurrency, reading out gift-card codes, or handing cash to a courier. Being told where to put your own money is this signal.',
  },
  remote_access: {
    family: 'access',
    hint: 'The user quotes being asked to install remote-access software — AnyDesk, TeamViewer, screen sharing — or to let someone else control their device. Mentioning a virus, or a computer problem, is not this.',
  },
  credential_request: {
    family: 'access',
    hint: 'Someone has actually asked for a one-time code, PIN, password, or full card details. Talking about a bank account or a virus is not this.',
  },
};

export const SIGNAL_IDS = Object.keys(SIGNALS);
export const FAMILY_IDS = Object.keys(FAMILIES);

// The normalisation step: whatever the model called it, this is what it counts as.
export const familyOf = (id) => SIGNALS[id]?.family ?? null;
export const familyWeight = (family) => FAMILIES[family]?.weight ?? 0;
export const familyLabel = (family) => FAMILIES[family]?.label ?? family;
