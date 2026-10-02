// Offline stand-in for the model, used when no API key is configured.
// It exercises the state machine, the tools and the UI with deterministic
// keyword matching. It is NOT the product — the real agent is src/agent.js.

const RULES = [
  [/\b(called|calling|texted|messaged|emailed|rang|pop-?up)\b.*\b(out of the blue|unexpected|didn'?t expect|random)\b|\b(cold ?call|robocall)\b/i, 'unsolicited_contact'],
  [/\b(from|claiming to be|says he'?s|says she'?s|said they were)\s+(the\s+)?(bank|microsoft|apple|amazon|police|irs|hmrc|tax|council|government|fraud team|support)\b/i, 'impersonation_authority'],
  [/\b(microsoft|apple support|bank'?s fraud|fraud department|tech support|the irs|hmrc)\b/i, 'impersonation_authority'],
  [/\b(right now|immediately|urgent|today or|within the hour|before it'?s too late|account will be (closed|frozen)|running out of time|has to be done now|straight away|before (it|the infection) spreads|no time to|before the bank (shuts|closes)|keeps saying it has to be done)\b/i, 'urgency_pressure'],
  [/\b(number (they|he|she) (gave|sent)|they gave me a number|called the number in the|rang them back on the number)\b/i, 'verification_bypass'],
  [/\b(in jail|in trouble|arrested|bailed out|sounded scared|crying|desperate|says he loves me|says she loves me)\b/i, 'emotional_manipulation'],
  [/\b(prize|you'?ve won|refund|owed you|guaranteed returns?|double your money|free money)\b/i, 'too_good_offer'],
  [/\b(don'?t tell|not to tell|not to mention|don'?t mention|keep (it|this) (quiet|between us)|secret|nobody can know|only worry)\b/i, 'secrecy_isolation'],
  [/\b(gift ?cards?|itunes cards?|steam cards?|wire transfer|western union|bitcoin|crypto|safe account|courier|cash in an envelope)\b/i, 'unusual_payment'],
  [/\b(anydesk|teamviewer|remote (access|desktop)|screen ?share|let them into my (computer|laptop)|install .* so they can)\b/i, 'remote_access'],
  [/\b(one.?time (code|password)|otp|my pin|my password|card number|security code|cvv|verification code|the code they (just )?(texted|sent)|read (them|him|her) the code)\b/i, 'credential_request'],
];

const REPLIES = {
  normal: "Sure — I've got that. Anything else?",
  curious: 'Got it. Out of curiosity, did they call you, or did you call them?',
  protective:
    "I want to flag something gently: that's how these calls usually start. Don't install anything yet — hang up and call the number on the back of your card. Want me to explain how this one works?",
  practice: "Hello, this is the fraud department. I'm seeing suspicious activity — I need to act fast. Can you confirm your card number?",
};

export async function mockTurn(state, history, userMessage, opts = {}) {
  const mode = opts.practice ? 'practice' : state.mode;
  const signals = opts.repair || opts.practice
    ? []
    : [...new Set(RULES.filter(([re]) => re.test(userMessage)).map(([, id]) => id))].map((id) => ({
        id,
        evidence: '(mock keyword match)',
      }));

  return { reply: REPLIES[mode], signals, tool: 'none', toolArg: '', usage: null, mock: true };
}
