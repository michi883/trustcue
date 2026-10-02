// Two optional tools. Both are code-owned: the agent may *request* one in its
// structured output, and the server decides whether to run it. Their content is
// deterministic so the protective moment never depends on the model improvising.

export const SCAM_PATTERNS = {
  tech_support: {
    title: 'the fake tech-support call',
    body: 'Real companies never call out of the blue about a virus, and they never need remote access to your computer. The call itself is the scam — the "fix" is usually them opening your banking.',
  },
  bank_impersonation: {
    title: 'the "safe account" bank scam',
    body: 'No real bank ever asks you to move money to a new account to protect it. Your bank will never call and ask you to transfer, withdraw, or hand cash to a courier.',
  },
  gift_card: {
    title: 'the gift-card payment scam',
    body: 'No legitimate organisation is paid in gift cards — not a tax office, not a utility, not a court. Once the codes are read out, the money is gone and cannot be traced.',
  },
  romance_crypto: {
    title: 'the investment scam that starts as a friendship',
    body: 'Someone you have not met in person, who moves the conversation to an investment with guaranteed returns, is running a script. The early withdrawals that work are bait.',
  },
  grandparent: {
    title: 'the family-emergency scam',
    body: 'A relative in trouble who needs money right now and asks you not to tell anyone is almost always someone else. Hang up and call that relative back on the number you already have.',
  },
  prize_refund: {
    title: 'the refund or prize scam',
    body: 'Money you did not expect, that requires a fee or your card details to release, is not money. Real refunds go back the way the payment came.',
  },
};

export const TOOLS = ['none', 'explain_scam_pattern', 'start_practice_simulation'];

export function explainScamPattern(patternId) {
  // Fail closed: explaining the wrong scam is worse than explaining none.
  const p = SCAM_PATTERNS[patternId];
  if (!p) return null;
  return {
    tool: 'explain_scam_pattern',
    arg: patternId,
    speech: `This one is called ${p.title}. ${p.body}`,
  };
}

export function startPracticeSimulation() {
  return {
    tool: 'start_practice_simulation',
    arg: '',
    speech:
      "Alright — I'll play the caller, you practise saying no. Nothing here is real, and you can say \"stop\" at any point.",
  };
}

// Tools are only reachable once the conversation is actually protective.
export function toolAllowed(mode) {
  return mode === 'protective';
}

const ASKED_DIRECTLY =
  /\bhow (does|do|did) (it|this|that|they|these)|how it works|why do you (think|say)|what do you mean|are you sure|i don'?t believe|prove it|explain|tell me more|practi[cs]e\b/i;
const ACCEPTED_OFFER = /^\s*(yes|yeah|yep|ok|okay|alright|sure|please|go on|do that|tell me|i would|go ahead)\b/i;

// A tool may only run when the user actually asked for it — either directly, or
// by accepting the offer TrustCue just made. Left to the model, the explainer
// fires on the same turn as the offer, and the user gets an answer to a question
// they were still being asked.
export function userRequestedTool(userMessage, history) {
  if (ASKED_DIRECTLY.test(userMessage)) return true;
  const lastSpoken = [...history].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  return lastSpoken.trim().endsWith('?') && ACCEPTED_OFFER.test(userMessage);
}
