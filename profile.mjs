// Fit scoring against Guille's proven audit specialties.
//
// The point is not to decide for him — it is to rank an incoming contest fast enough
// that he can commit on day one instead of reading five landing pages. A HIGH here
// means "the attack surface you have already broken before is present in the scope".

export const SPECIALTIES = [
  {
    key: 'oracle-pricing',
    label: 'pricing anclado a oraculos',
    weight: 3,
    patterns: [
      /\boracle/i, /price feed/i, /\btwap\b/i, /chainlink/i, /\bpyth\b/i,
      /staleness|stale price/i, /deviation/i, /price band/i, /\banchor(ed)?\b/i,
      /heartbeat/i, /circuit breaker/i,
    ],
  },
  {
    key: 'price-convention',
    label: 'convenciones de precio inconsistentes',
    weight: 3,
    patterns: [
      /\bamm\b/i, /\bswap\b/i, /mid ?price/i, /geometric mean/i, /invariant/i,
      /\bcurve\b/i, /spot price/i, /\bsqrt ?price/i, /\btick\b/i, /liquidity pool/i,
      /market mak/i,
    ],
  },
  {
    key: 'hooks-reentrancy',
    label: 'hooks/extensiones y reentrancy',
    weight: 3,
    patterns: [
      /\bhook/i, /\bextension/i, /\bcallback/i, /\bplugin/i, /\bmodule\b/i,
      /\brouter\b/i, /arbitrary (contract|call)/i, /reentran/i, /\bdelegatecall/i,
      /\bmiddleware\b/i,
    ],
  },
  {
    key: 'permissionless-factory',
    label: 'factories permissionless',
    weight: 2,
    patterns: [
      /\bfactory\b/i, /permissionless/i, /\bcreate2\b/i, /\bregistry\b/i,
      /anyone can (deploy|create)/i, /deploy(er|ment)? pattern/i, /whitelist/i,
    ],
  },
  {
    key: 'fixed-point-math',
    label: 'matematica de punto fijo',
    weight: 2,
    patterns: [
      /fixed[- ]point/i, /\bwad\b/i, /\bray\b/i, /muldiv/i, /rounding/i,
      /truncat/i, /precision loss/i, /\bfee(s)?\b/i, /basis points|\bbps\b/i,
      /\bdecimals?\b/i,
    ],
  },
];

// Stacks Guille does not audit. Presence of these without Solidity rules a contest out.
const OFF_STACK = /^(Rust|Solana|Cairo|Move|CosmWasm)$/i;
const ON_STACK = /^(Solidity|Foundry|Vyper|Solidity\?)$/i;

// Contest descriptions are two-sentence marketing pitches, not audit scopes. They will
// never contain "staleness", "mulDiv" or "rounding direction" — that vocabulary lives in
// the code. What a pitch does reveal is the KIND of protocol, and the kind implies the
// attack surface: a DEX always has price conventions, a lending market always leans on an
// oracle, a protocol with programmable pools always calls contracts it does not control.
//
// Calibrated against 265 real contests pulled from all five platforms. Before this layer
// existed, Metric — the contest whose stop-loss watermark and router refund paths Guille
// actually broke — scored 5/MEDIO, and only 1 of 265 contests ever reached ALTO.
const DOMAIN_SIGNALS = [
  {
    re: /\bdex\b|automated market maker|\bamm\b|market mak|order ?book|\bswap|liquidity pool|spot (and|&) perp|trading/i,
    weight: 6,
    label: 'DEX/AMM — convenciones de precio entre componentes',
    specialties: ['price-convention', 'fixed-point-math'],
  },
  {
    re: /oracle|price ?feed|price data|\btwap\b|chainlink|pyth\b|redstone/i,
    weight: 9,
    label: 'oraculo explicito — bandas, staleness, desviacion',
    specialties: ['oracle-pricing'],
  },
  {
    re: /lending|borrow|collateral|liquidat|money market|\bcdp\b|perpetual|derivativ|leverage|margin|options? (trading|protocol)/i,
    weight: 6,
    label: 'lending/derivados — dependencia de oraculo y liquidacion',
    specialties: ['oracle-pricing'],
  },
  {
    re: /programmable|extensions?\b|plugins?\b|modular|modules?\b|hooks?\b|callback|custom logic|arbitrary (call|contract)|composab/i,
    weight: 6,
    label: 'arquitectura extensible — el protocolo llama contratos arbitrarios',
    specialties: ['hooks-reentrancy'],
  },
  {
    re: /anyone can (deploy|create|launch|spin)|permissionless|\bfactory\b|deploy (their own|pools|markets)/i,
    weight: 5,
    label: 'despliegue permissionless — predicados de confianza',
    specialties: ['permissionless-factory'],
  },
  {
    re: /stablecoin|\bpeg\b|rebase|real[- ]world asset|\brwa\b|tokeniz|synthetic/i,
    weight: 5,
    label: 'stablecoin/RWA — anclaje de precio',
    specialties: ['oracle-pricing', 'price-convention'],
  },
  {
    re: /vault|yield|staking|share price|deposit|redeem|\bfees?\b/i,
    weight: 4,
    label: 'vault/yield — redondeo, shares y fees',
    specialties: ['fixed-point-math'],
  },
];

export function scoreContest(contest) {
  const blob = [contest.name, contest.description, contest.url, (contest.stack ?? []).join(' ')]
    .filter(Boolean).join(' ');

  const matches = [];
  let score = 0;

  // Coarse layer: what kind of protocol is this, and what does that imply?
  const domains = [];
  for (const sig of DOMAIN_SIGNALS) {
    const m = blob.match(sig.re);
    if (m) {
      score += sig.weight;
      domains.push({ label: sig.label, hit: m[0].toLowerCase() });
    }
  }

  // Fine layer: explicit audit vocabulary, when the pitch happens to carry it.
  for (const spec of SPECIALTIES) {
    const hits = [];
    for (const re of spec.patterns) {
      const m = blob.match(re);
      if (m) hits.push(m[0].toLowerCase());
    }
    if (hits.length) {
      // Diminishing returns: breadth across specialties beats one keyword repeated.
      score += spec.weight * Math.min(hits.length, 3);
      matches.push({ key: spec.key, label: spec.label, hits: [...new Set(hits)].slice(0, 4) });
    }
  }

  // Domain signals are what actually carries the judgment, so surface them first.
  for (const d of domains.reverse()) {
    matches.unshift({ key: 'domain', label: d.label, hits: [d.hit] });
  }

  const stack = contest.stack ?? [];
  const hasOn = stack.some((s) => ON_STACK.test(s));
  const hasOff = stack.some((s) => OFF_STACK.test(s));

  let level;
  let reason;

  if (hasOff && !hasOn) {
    level = 'FUERA DE ZONA';
    reason = `stack ${stack.join('/')} — fuera de Solidity/Foundry`;
  } else if (score >= 20) {
    level = 'ALTO';
    reason = matches.map((m) => m.label).slice(0, 3).join(' + ');
  } else if (score >= 10) {
    level = 'MEDIO';
    reason = matches.map((m) => m.label).slice(0, 2).join(' + ');
  } else {
    level = 'BAJO';
    reason = matches.length ? matches[0].label : 'sin senales de tus especialidades en la descripcion';
  }

  // A contest with no description cannot be judged; say so instead of scoring it low.
  if (!contest.description && score === 0 && level !== 'FUERA DE ZONA') {
    level = 'SIN DATOS';
    reason = 'la plataforma no expone descripcion — revisar a mano';
  }

  return { level, score, matches, reason };
}

// Emoji marker so the Telegram digest is scannable at a glance.
export const LEVEL_MARK = {
  'ALTO': '\u{1F7E2}',
  'MEDIO': '\u{1F7E1}',
  'BAJO': '⚪',
  'SIN DATOS': '❓',
  'FUERA DE ZONA': '⚫',
};
