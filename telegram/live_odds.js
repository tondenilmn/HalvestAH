'use strict';
// ── LIVE ODDS ENGINE (Poisson time-decay) — Node port of static/app.js's
// computeLiveOdd and its dependencies. Ported verbatim (2026-08-22) rather
// than re-derived, to keep the two in sync — see CLAUDE.md's sync
// requirement note and app.js's own comments for the full history/rationale
// behind each constant (curve empirically derived from goals_time2,
// _TOTAL_SCORE_MOD likewise, _FAV_SCORE_MOD/_DOG_SCORE_MOD left as the
// original Bet365-CSV-derived approximation — see app.js for the caveats).
// If you change the model in app.js, mirror it here.
//
// Phase 0 plumbing-bug fixes (2026-08-28, see LIVE_BETTING_PLAN.md) mirrored
// here: 0.4 (stoppage-time decay, was frozen at minute 90), 0.5
// (alreadyDecided flag on computeLiveResult2H/computeLiveBtts2H), 0.6
// (removed _LINE_STRENGTH_MOD double-count and the undocumented bayMod
// shrink). Only what already existed in this file was touched — no new
// functionality (e.g. no 1H functions) was added, per the sync-requirement
// note: this file intentionally lags app.js's feature set until a Telegram
// strategy actually needs the missing piece.

const _1H_INTENSITY = [[0,15,0.907],[15,30,0.937],[30,45,1.156]];
const _2H_INTENSITY = [[0,15,0.879],[15,30,0.874],[30,45,1.247]];
const _FLAT_INTENSITY = [[0,45,1.000]];
// Calibrated from goals_time2 (2026-08-26) — see static/app.js's matching
// constant for the full methodology/sample size; mirrored here per the
// sync-requirement note above.
const _IT_2H = 5.07;
const _IT_1H = 2.40;
// Average REAL stoppage minutes played when it happens — see static/app.js's
// matching _STOP_MIN_2H/_STOP_MIN_1H comments (Phase 0 fix 0.4) for the full
// derivation.
const _STOP_MIN_2H = 3.72;
const _STOP_MIN_1H = 2.65;

// ── 1H live decay — ported 2026-08-29 for Strategy FOCUS (see
// PLAN_FOCUS_BETS.md Phase 3), which is the first Telegram strategy whose bet
// list includes 1H markets. Verbatim port of static/app.js's
// computeLive1HOdd/computeLiveResult1H/computeLiveBtts1H — see those
// functions' comments there for the full rationale (anchored at kickoff
// instead of HT, no score-state modifier since that relationship was never
// measured for within-half margins).
const _1H_RESULT_KEYS = new Set(['favWins1H', 'draw1H', 'homeWins1H', 'awayWins1H']);
const _1H_BETS_SET = new Set([
  'over05_1H', 'over15_1H', 'homeScored1H', 'awayScored1H',
  'under05_1H', 'under15_1H',
]);
const _UNDER_BETS_1H = {'under05_1H':[1,0],'under15_1H':[2,1]};
const _BET_GOAL_THRESHOLD_1H = {
  'over05_1H':1,'over15_1H':2,
  'homeScored1H':1,'awayScored1H':1,
};

// REMOVED 2026-08-28 (Phase 0 fix 0.6): _LINE_STRENGTH_MOD used to
// re-multiply lambda by a fav_line-keyed factor — double-counted the line's
// effect since the anchor historical pool is already filtered by fav_line
// before scoreBets() runs. Also removed: the unconditional, undocumented
// `bayMod = 1 - (elapsed/45)*0.05` shrink factor — treated as 1 (no-op).
// The 2H "who wins the half" 3-way market (favWins2H/draw2H/homeWins2H/
// awayWins2H) is deliberately excluded — see static/app.js's matching
// comment: "who wins/draws the 2nd half" depends on the joint evolution of
// BOTH sides' goal counts, not a single threshold. Falling through to the
// generic "at least 1 goal" default flipped draw2H to a bogus 100% the
// moment any 2H goal was scored by either side, and homeWins2H/awayWins2H to
// a bogus 100% the instant that side took any 2H lead. app.js fixed this
// with a proper bivariate model (computeLiveResult2H) — not ported here since
// no current Telegram strategy's bet list includes any of these four keys;
// port it verbatim from app.js if one ever does, same as everything else in
// this file.
const _2H_BETS_SET = new Set([
  'over05_2H','over15_2H','over25_2H','favScored2H','ahCover',
  'homeScored2H','awayScored2H',
  'homeOver15_2H','awayOver15_2H','under05_2H','under15_2H',
]);
const _FT_BETS_SET = new Set([
  'noDrawFT','favWinsFT','homeWinsFT','awayWinsFT',
  'over25FT','over15FT','over35FT','under25FT','drawFT','btts',
  'favWins1H','draw1H','favScored1H','homeWins1H','awayWins1H',
  'over05_1H','over15_1H','under05_1H','under15_1H','btts1H',
]);
const _UNDER_BETS = {'under05_2H':[1,0],'under15_2H':[2,1]};
const _BET_GOAL_THRESHOLD = {
  'over05_2H':1,'over15_2H':2,'over25_2H':3,
  'favScored2H':1,'ahCover':1,
  'homeScored2H':1,'awayScored2H':1,
  'homeOver15_2H':2,'awayOver15_2H':2,
};

const _FAV_SCORE_MOD   = {'-2':1.08, '-1':1.08, '0':1.00, '1':1.09, '2':1.45};
const _DOG_SCORE_MOD   = {'-2':1.32, '-1':1.09, '0':1.00, '1':1.06, '2':1.04};
const _TOTAL_SCORE_MOD = {'-2':1.035, '-1':1.023, '0':1.00, '1':1.023, '2':1.035};
const _BET_SCORE_MOD_CLASS = {
  favScored2H:'fav', ahCover:'fav',
  homeScored2H:'side', awayScored2H:'side',
  homeOver15_2H:'side', awayOver15_2H:'side',
  over05_2H:'total', over15_2H:'total', over25_2H:'total',
  under05_2H:'total', under15_2H:'total',
};

function _marginBucket(d){
  if(d<=-2)return '-2'; if(d===-1)return '-1'; if(d===0)return '0';
  if(d===1)return '1'; return '2';
}

function _pickScoreMod(betKey, fav2h, dog2h, favSide){
  const cls = _BET_SCORE_MOD_CLASS[betKey];
  const bucket = _marginBucket(fav2h - dog2h);
  if(cls === 'fav')   return _FAV_SCORE_MOD[bucket];
  if(cls === 'total') return _TOTAL_SCORE_MOD[bucket];
  if(cls === 'side'){
    const isFavBet = (favSide === 'HOME' && (betKey === 'homeScored2H' || betKey === 'homeOver15_2H'))
                   || (favSide === 'AWAY' && (betKey === 'awayScored2H' || betKey === 'awayOver15_2H'));
    return isFavBet ? _FAV_SCORE_MOD[bucket] : _DOG_SCORE_MOD[bucket];
  }
  return 1.0;
}

function _fac(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r;}

function _goalIntAt(e,half,curve){
  const t = curve || (half===1?_1H_INTENSITY:_2H_INTENSITY);
  for(const[s,en,m]of t)if(e>=s&&e<en)return m;
  return t[t.length-1][2];
}

function _integrateInt(from,to,half,curve){
  if(to<=from)return 0;
  const steps=Math.max(1,Math.round((to-from)*4));
  const step=(to-from)/steps;
  let total=0;
  for(let i=0;i<steps;i++)total+=_goalIntAt(from+(i+0.5)*step,half,curve)*step;
  return total;
}

function _baseInt2h(curve){
  const c = curve || _2H_INTENSITY;
  return _integrateInt(0,45,2,c)+c[c.length-1][2]*_IT_2H;
}

function _baseInt1h(curve){
  const c = curve || _1H_INTENSITY;
  return _integrateInt(0,45,1,c)+c[c.length-1][2]*_IT_1H;
}

function _solveLam(p,k,lo=0,hi=50,iters=60){
  for(let i=0;i<iters;i++){
    const mid=(lo+hi)/2;
    let prob=0;
    for(let j=0;j<k;j++)prob+=Math.exp(-mid)*Math.pow(mid,j)/_fac(j);
    if(1-prob<p)lo=mid;else hi=mid;
  }
  return(lo+hi)/2;
}

function _poissonAtLeast(lam,k){
  if(lam<=0)return 0;
  if(k<=0)return 1;
  let cum=0;
  for(let i=0;i<Math.min(k,30);i++)cum+=Math.exp(-lam)*Math.pow(lam,i)/_fac(i);
  return Math.max(0,Math.min(1,1-cum));
}

function computeLiveOdd(pHtPct,betKey,matchMinute,favLine=0.75,
                        favGoals2h=0,dogGoals2h=0,favSide='HOME',useFlatDecay=false){
  if(_FT_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'Full-time bet — HT reference only'};
  if(!_2H_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'—'};

  const curve=useFlatDecay?_FLAT_INTENSITY:_2H_INTENSITY;
  const homeG2h=favSide==='HOME'?favGoals2h:dogGoals2h;
  const awayG2h=favSide==='HOME'?dogGoals2h:favGoals2h;
  const p=Math.max(0.001,Math.min(0.999,pHtPct/100));

  let lam;
  if(_UNDER_BETS[betKey]){
    const[kl]=_UNDER_BETS[betKey];
    const po=Math.max(0.001,Math.min(0.999,1-p));
    lam=kl===1?-Math.log(1-po):_solveLam(po,kl);
  }else{
    const k=_BET_GOAL_THRESHOLD[betKey]||1;
    lam=k===1?-Math.log(1-p):_solveLam(p,k);
  }

  // favLine no longer multiplies lambda — see the "REMOVED 2026-08-28"
  // comment near the top of this file (Phase 0 fix 0.6). Param kept for
  // call-signature compatibility only.

  const baseInt=_baseInt2h(curve);
  // elapsed2h is no longer capped at 45 — minutes played beyond 90' (real
  // stoppage time) now extend past 45 so the stoppage-mass consumption below
  // decays smoothly instead of being frozen at whatever it was at exactly
  // minute 90 (Phase 0 fix 0.4).
  let elapsed2h,remaining2h,note,fg2h=favGoals2h,dg2h=dogGoals2h;
  if(matchMinute<=45){
    elapsed2h=0;remaining2h=45;fg2h=0;dg2h=0;
    note=`1H min ${matchMinute} — full 2H ahead`;
  }else{
    elapsed2h=matchMinute-45;
    remaining2h=Math.max(0,45-Math.min(45,elapsed2h));
    note=`Min ${matchMinute} — ${Math.round(remaining2h)} min left in 2H`;
  }

  const regPart=Math.min(45,elapsed2h);
  const extraPart=Math.max(0,elapsed2h-45); // real minutes played into 2H stoppage time
  const itRate=curve[curve.length-1][2];
  const itFrac=Math.max(0,1-extraPart/_STOP_MIN_2H); // 1 at 90', decays to 0 by ~90'+_STOP_MIN_2H
  const remInt=_integrateInt(regPart,45,2,curve)+itRate*_IT_2H*itFrac;
  const intFrac=remInt/baseInt;
  let remLam=lam*intFrac*_pickScoreMod(betKey,fg2h,dg2h,favSide);

  const goalsScored=fg2h+dg2h;
  let liveP;

  if(_UNDER_BETS[betKey]){
    const[,maxG]=_UNDER_BETS[betKey];
    if(goalsScored>maxG)return{live_p:0,fair_odd:99,note:note+' ✗ Already busted',alreadyDecided:true};
    const allowed=maxG-goalsScored;
    let prob=0;
    for(let i=0;i<=allowed;i++)prob+=Math.exp(-remLam)*Math.pow(remLam,i)/_fac(i);
    liveP=prob*100;
  }else{
    let need;
    if(betKey==='homeScored2H')      need=Math.max(0,1-homeG2h);
    else if(betKey==='awayScored2H') need=Math.max(0,1-awayG2h);
    else if(betKey==='homeOver15_2H')need=Math.max(0,2-homeG2h);
    else if(betKey==='awayOver15_2H')need=Math.max(0,2-awayG2h);
    else need=Math.max(0,(_BET_GOAL_THRESHOLD[betKey]||1)-goalsScored);

    if(need===0)return{live_p:100,fair_odd:1.01,note:note+' ✓ Already hit',alreadyDecided:true};
    liveP=_poissonAtLeast(remLam,need)*100;
  }

  return{
    live_p:Math.round(liveP*10)/10,
    fair_odd:Math.round(1/Math.max(liveP/100,0.001)*100)/100,
    note,
  };
}

// 1H mirror of computeLiveOdd — verbatim port of static/app.js's
// computeLive1HOdd. Anchored at kickoff instead of HT (always 0-0, so no
// anchor-goal snapshot to subtract; homeGoals1h/awayGoals1h are just the
// current score directly). Deliberately has NO score-state modifier — the 2H
// tables are calibrated from HT-margin -> rest-of-2H scoring, a different
// question than "does the score-so-far within the same half change the rest
// of that half", which was never measured; applying the 2H tables here would
// misrepresent an untested relationship.
function computeLive1HOdd(pKickoffPct,betKey,matchMinute,favLine=0.75,
                          homeGoals1h=0,awayGoals1h=0,useFlatDecay=false){
  if(!_1H_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'—'};

  const curve=useFlatDecay?_FLAT_INTENSITY:_1H_INTENSITY;
  const p=Math.max(0.001,Math.min(0.999,pKickoffPct/100));

  let lam;
  if(_UNDER_BETS_1H[betKey]){
    const[kl]=_UNDER_BETS_1H[betKey];
    const po=Math.max(0.001,Math.min(0.999,1-p));
    lam=kl===1?-Math.log(1-po):_solveLam(po,kl);
  }else{
    const k=_BET_GOAL_THRESHOLD_1H[betKey]||1;
    lam=k===1?-Math.log(1-p):_solveLam(p,k);
  }

  // favLine no longer multiplies lambda — see the "REMOVED 2026-08-28"
  // comment near the top of this file (Phase 0 fix 0.6).

  const baseInt=_baseInt1h(curve);
  const elapsed1h=Math.max(0,matchMinute);
  const remaining1h=Math.max(0,45-Math.min(45,elapsed1h));
  const note=`Min ${matchMinute} — ${Math.round(remaining1h)} min left in 1H`;

  const regPart=Math.min(45,elapsed1h);
  const extraPart=Math.max(0,elapsed1h-45); // real minutes played into 1H stoppage time
  const itRate=curve[curve.length-1][2];
  const itFrac=Math.max(0,1-extraPart/_STOP_MIN_1H);
  const remInt=_integrateInt(regPart,45,1,curve)+itRate*_IT_1H*itFrac;
  const intFrac=remInt/baseInt;
  let remLam=lam*intFrac;

  const goalsScored=homeGoals1h+awayGoals1h;
  let liveP;

  if(_UNDER_BETS_1H[betKey]){
    const[,maxG]=_UNDER_BETS_1H[betKey];
    if(goalsScored>maxG)return{live_p:0,fair_odd:99,note:note+' ✗ Already busted',alreadyDecided:true};
    const allowed=maxG-goalsScored;
    let prob=0;
    for(let i=0;i<=allowed;i++)prob+=Math.exp(-remLam)*Math.pow(remLam,i)/_fac(i);
    liveP=prob*100;
  }else{
    let need;
    if(betKey==='homeScored1H')      need=Math.max(0,1-homeGoals1h);
    else if(betKey==='awayScored1H') need=Math.max(0,1-awayGoals1h);
    else need=Math.max(0,(_BET_GOAL_THRESHOLD_1H[betKey]||1)-goalsScored);

    if(need===0)return{live_p:100,fair_odd:1.01,note:note+' ✓ Already hit',alreadyDecided:true};
    liveP=_poissonAtLeast(remLam,need)*100;
  }

  return{
    live_p:Math.round(liveP*10)/10,
    fair_odd:Math.round(1/Math.max(liveP/100,0.001)*100)/100,
    note,
  };
}

// 1H mirror of computeLiveResult2H — bivariate live decay for the 1H "who
// wins the half" 3-way market (favWins1H/draw1H/homeWins1H/awayWins1H).
// Anchored at kickoff: favGoals1h/dogGoals1h are the current score directly,
// and there is no score-state margin modifier (see computeLive1HOdd above).
function computeLiveResult1H(favAnchorP, dogAnchorP, matchMinute, favLine, favGoals1h, dogGoals1h, useFlatDecay) {
  const curve = useFlatDecay ? _FLAT_INTENSITY : _1H_INTENSITY;
  const toLam = p => -Math.log(1 - Math.max(0.001, Math.min(0.999, p / 100)));
  let lamFav = toLam(favAnchorP), lamDog = toLam(dogAnchorP);

  const baseInt = _baseInt1h(curve);
  const elapsed1h = Math.max(0, matchMinute);
  const regPart = Math.min(45, elapsed1h);
  const extraPart = Math.max(0, elapsed1h - 45);
  const itRate = curve[curve.length - 1][2];
  const itFrac = Math.max(0, 1 - extraPart / _STOP_MIN_1H);
  const remInt = _integrateInt(regPart, 45, 1, curve) + itRate * _IT_1H * itFrac;
  const intFrac = remInt / baseInt;

  const remLamFav = lamFav * intFrac;
  const remLamDog = lamDog * intFrac;

  const REMLAM_EPS = 1e-6;
  if (remLamFav < REMLAM_EPS && remLamDog < REMLAM_EPS) {
    const finalMargin = favGoals1h - dogGoals1h;
    return {
      fav_win_p: finalMargin > 0 ? 100 : 0,
      draw_p:    finalMargin === 0 ? 100 : 0,
      dog_win_p: finalMargin < 0 ? 100 : 0,
      alreadyDecided: true,
    };
  }

  const CAP = 10;
  let favWinP = 0, drawP = 0, dogWinP = 0;
  for (let i = 0; i <= CAP; i++) {
    const pi = Math.exp(-remLamFav) * Math.pow(remLamFav, i) / _fac(i);
    for (let j = 0; j <= CAP; j++) {
      const pj = Math.exp(-remLamDog) * Math.pow(remLamDog, j) / _fac(j);
      const p = pi * pj;
      const finalMargin = (favGoals1h + i) - (dogGoals1h + j);
      if (finalMargin > 0) favWinP += p;
      else if (finalMargin === 0) drawP += p;
      else dogWinP += p;
    }
  }
  const total = favWinP + drawP + dogWinP;
  return total > 0
    ? { fav_win_p: favWinP / total * 100, draw_p: drawP / total * 100, dog_win_p: dogWinP / total * 100 }
    : { fav_win_p: 0, draw_p: 0, dog_win_p: 0 };
}

// 1H mirror of computeLiveBtts2H — product of each side's own live "scores
// in 1H" probability.
function computeLiveBtts1H(homeAnchorP, awayAnchorP, minute, favLine, homeG1h, awayG1h, useFlatDecay) {
  const homeRes = computeLive1HOdd(homeAnchorP, 'homeScored1H', minute, favLine, homeG1h, awayG1h, useFlatDecay);
  const awayRes = computeLive1HOdd(awayAnchorP, 'awayScored1H', minute, favLine, homeG1h, awayG1h, useFlatDecay);
  if (homeRes.live_p == null || awayRes.live_p == null) return null;
  return {
    live_p: Math.round(homeRes.live_p * awayRes.live_p) / 100,
    alreadyDecided: !!(homeRes.alreadyDecided && awayRes.alreadyDecided),
  };
}

// Bivariate live decay for the 2H "who wins the half" 3-way market
// (favWins2H/draw2H/homeWins2H/awayWins2H) — verbatim port of static/app.js's
// computeLiveResult2H (see its comment there for the full rationale: these
// can't go through computeLiveOdd's single-threshold path since the outcome
// depends on the joint evolution of BOTH sides' goal counts, not one count
// crossing a threshold). Ported 2026-08-27 for Strategy HTPICK, which is the
// first Telegram strategy whose bet list includes these four keys.
const _2H_RESULT_KEYS = new Set(['favWins2H', 'draw2H', 'homeWins2H', 'awayWins2H']);

function computeLiveResult2H(favAnchorP, dogAnchorP, matchMinute, favLine, favGoals2h, dogGoals2h, useFlatDecay) {
  const curve = useFlatDecay ? _FLAT_INTENSITY : _2H_INTENSITY;
  const toLam = p => -Math.log(1 - Math.max(0.001, Math.min(0.999, p / 100)));
  let lamFav = toLam(favAnchorP), lamDog = toLam(dogAnchorP);

  // favLine no longer multiplies lamFav — see the "REMOVED 2026-08-28"
  // comment near the top of this file (Phase 0 fix 0.6).

  const baseInt = _baseInt2h(curve);
  let elapsed2h, fg2h = favGoals2h, dg2h = dogGoals2h;
  if (matchMinute <= 45) { elapsed2h = 0; fg2h = 0; dg2h = 0; }
  else { elapsed2h = matchMinute - 45; }
  const regPart = Math.min(45, elapsed2h);
  const extraPart = Math.max(0, elapsed2h - 45);
  const itRate = curve[curve.length - 1][2];
  const itFrac = Math.max(0, 1 - extraPart / _STOP_MIN_2H);
  const remInt = _integrateInt(regPart, 45, 2, curve) + itRate * _IT_2H * itFrac;
  const intFrac = remInt / baseInt;

  const bucket = _marginBucket(fg2h - dg2h);
  const remLamFav = lamFav * intFrac * _FAV_SCORE_MOD[bucket];
  const remLamDog = lamDog * intFrac * _DOG_SCORE_MOD[bucket];

  // Phase 0 fix 0.5: when there's effectively no remaining goal-scoring mass
  // left for EITHER side, the final margin is already fixed by fg2h/dg2h —
  // flag alreadyDecided so callers (notify.js) can skip pricing/alerting a
  // market that's already resolved instead of showing a probability that's
  // still (very slightly) short of 100%/0%.
  const REMLAM_EPS = 1e-6;
  if (remLamFav < REMLAM_EPS && remLamDog < REMLAM_EPS) {
    const finalMargin = fg2h - dg2h;
    return {
      fav_win_p: finalMargin > 0 ? 100 : 0,
      draw_p:    finalMargin === 0 ? 100 : 0,
      dog_win_p: finalMargin < 0 ? 100 : 0,
      alreadyDecided: true,
    };
  }

  const CAP = 10; // 2H goal counts beyond this are negligible at any realistic lambda
  let favWinP = 0, drawP = 0, dogWinP = 0;
  for (let i = 0; i <= CAP; i++) {
    const pi = Math.exp(-remLamFav) * Math.pow(remLamFav, i) / _fac(i);
    for (let j = 0; j <= CAP; j++) {
      const pj = Math.exp(-remLamDog) * Math.pow(remLamDog, j) / _fac(j);
      const p = pi * pj;
      const finalMargin = (fg2h + i) - (dg2h + j);
      if (finalMargin > 0) favWinP += p;
      else if (finalMargin === 0) drawP += p;
      else dogWinP += p;
    }
  }
  const total = favWinP + drawP + dogWinP; // ~1 minus CAP truncation — renormalize
  return total > 0
    ? { fav_win_p: favWinP / total * 100, draw_p: drawP / total * 100, dog_win_p: dogWinP / total * 100 }
    : { fav_win_p: 0, draw_p: 0, dog_win_p: 0 };
}

// BTTS 2H — verbatim port of static/app.js's computeLiveBtts2H. Modeled as
// the product of each side's own live "scores in 2H" probability, same
// independence assumption as the app.js original. Phase 0 fix 0.5: now
// returns { live_p, alreadyDecided } instead of a raw number — alreadyDecided
// once BOTH sides' own computeLiveOdd call has itself resolved.
function computeLiveBtts2H(homeAnchorP, awayAnchorP, minute, favLine, favG2h, dogG2h, favSide, useFlatDecay) {
  const homeRes = computeLiveOdd(homeAnchorP, 'homeScored2H', minute, favLine, favG2h, dogG2h, favSide, useFlatDecay);
  const awayRes = computeLiveOdd(awayAnchorP, 'awayScored2H', minute, favLine, favG2h, dogG2h, favSide, useFlatDecay);
  if (homeRes.live_p == null || awayRes.live_p == null) return null;
  return {
    live_p: Math.round(homeRes.live_p * awayRes.live_p) / 100,
    alreadyDecided: !!(homeRes.alreadyDecided && awayRes.alreadyDecided),
  };
}

// Which computeLiveResult2H output field each of the 4 "2H Result" keys
// reads, given which side is the favourite — verbatim port of app.js's
// _2hResultField.
function _2hResultField(betKey, favSide) {
  if (betKey === 'draw2H') return 'draw_p';
  if (betKey === 'favWins2H') return 'fav_win_p';
  const isHomeKey = betKey === 'homeWins2H';
  const homeIsFav = favSide === 'HOME';
  return (isHomeKey === homeIsFav) ? 'fav_win_p' : 'dog_win_p';
}

// Phase 0 fix 0.8 — Monte Carlo confidence interval for the bivariate/BTTS
// live-decay markets, port of static/app.js's _mcLivePercentile/_mcLiveLo/
// _mcLiveHi. Replaces "run once with both anchors at their own Wilson lower
// bound" (invalid joint lower bound — see app.js's comment for the full
// rationale) with 500 independent joint draws per anchor's approximate
// Normal(p, se) distribution (se derived from [lo,hi] as a ~95% CI), taking
// the requested percentile of the resulting target-field values.
const _MC_SAMPLES = 500;

function _boxMullerSample(mean, se) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * se;
}

function _wilsonSE(lo, hi) {
  return Math.max(0.01, (hi - lo) / (2 * 1.96));
}

function _mcLivePercentile(anchorA, anchorB, buildFn, pct) {
  const seA = _wilsonSE(anchorA.lo, anchorA.hi);
  const seB = _wilsonSE(anchorB.lo, anchorB.hi);
  const samples = [];
  for (let i = 0; i < _MC_SAMPLES; i++) {
    const a = Math.max(0.1, Math.min(99.9, _boxMullerSample(anchorA.p, seA)));
    const b = Math.max(0.1, Math.min(99.9, _boxMullerSample(anchorB.p, seB)));
    const v = buildFn(a, b);
    if (v != null) samples.push(v);
  }
  if (!samples.length) return null;
  samples.sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(samples.length - 1, Math.floor(samples.length * pct)));
  return samples[idx];
}
function mcLiveLo(anchorA, anchorB, buildFn) { return _mcLivePercentile(anchorA, anchorB, buildFn, 0.05); }
function mcLiveHi(anchorA, anchorB, buildFn) { return _mcLivePercentile(anchorA, anchorB, buildFn, 0.95); }

module.exports = {
  computeLiveOdd, _2H_BETS_SET, _BET_SCORE_MOD_CLASS,
  computeLiveResult2H, computeLiveBtts2H, _2hResultField, _2H_RESULT_KEYS,
  computeLive1HOdd, computeLiveResult1H, computeLiveBtts1H,
  _1H_BETS_SET, _1H_RESULT_KEYS,
  mcLiveLo, mcLiveHi,
};
