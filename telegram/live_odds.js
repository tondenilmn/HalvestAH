'use strict';
// ── LIVE ODDS ENGINE (Poisson time-decay) — Node port of static/app.js's
// computeLiveOdd and its dependencies. Ported verbatim (2026-08-22) rather
// than re-derived, to keep the two in sync — see CLAUDE.md's sync
// requirement note and app.js's own comments for the full history/rationale
// behind each constant (curve empirically derived from goals_time2,
// _TOTAL_SCORE_MOD likewise, _FAV_SCORE_MOD/_DOG_SCORE_MOD left as the
// original Bet365-CSV-derived approximation — see app.js for the caveats).
// If you change the model in app.js, mirror it here.

const _1H_INTENSITY = [[0,15,0.907],[15,30,0.937],[30,45,1.156]];
const _2H_INTENSITY = [[0,15,0.879],[15,30,0.874],[30,45,1.247]];
const _FLAT_INTENSITY = [[0,45,1.000]];
// Calibrated from goals_time2 (2026-08-26) — see static/app.js's matching
// constant for the full methodology/sample size; mirrored here per the
// sync-requirement note above.
const _IT_2H = 5.07;

const _LINE_STRENGTH_MOD = {0.25:0.92,0.50:0.96,0.75:1.00,1.00:1.06,1.25:1.12,1.50:1.18};
// The 2H "who wins the half" 3-way market (favWins2H/draw2H/homeWins2H/
// awayWins2H) is deliberately excluded — see static/app.js's matching
// comment: "who wins/draws the 2nd half" depends on the joint evolution of
// BOTH sides' goal counts, not a single threshold. Falling through to the
// generic "at least 1 goal" default flipped draw2H to a bogus 100% the
// moment any 2H goal was scored, and homeWins2H/awayWins2H to a bogus 100%
// the instant that side took any 2H lead. app.js fixed this with a proper
// bivariate model (computeLiveResult2H) — not ported here since no current
// Telegram strategy's bet list includes any of these four keys; port it
// verbatim from app.js if one ever does, same as everything else in this file.
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

  const lineKeys=Object.keys(_LINE_STRENGTH_MOD).map(Number);
  const closest=lineKeys.reduce((a,b)=>Math.abs(b-favLine)<Math.abs(a-favLine)?b:a);
  lam*=_LINE_STRENGTH_MOD[closest];

  const baseInt=_baseInt2h(curve);
  let elapsed2h,remaining2h,note,fg2h=favGoals2h,dg2h=dogGoals2h;
  if(matchMinute<=45){
    elapsed2h=0;remaining2h=45;fg2h=0;dg2h=0;
    note=`1H min ${matchMinute} — full 2H ahead`;
  }else{
    elapsed2h=Math.min(45,matchMinute-45);
    remaining2h=Math.max(0,45-elapsed2h);
    note=`Min ${matchMinute} — ${Math.round(remaining2h)} min left in 2H`;
  }

  const itRate=curve[curve.length-1][2];
  const remInt=_integrateInt(elapsed2h,45,2,curve)+itRate*_IT_2H;
  const intFrac=remInt/baseInt;
  const bayMod=1-(elapsed2h/45)*0.05;
  let remLam=lam*intFrac*bayMod*_pickScoreMod(betKey,fg2h,dg2h,favSide);

  const goalsScored=fg2h+dg2h;
  let liveP;

  if(_UNDER_BETS[betKey]){
    const[,maxG]=_UNDER_BETS[betKey];
    if(goalsScored>maxG)return{live_p:0,fair_odd:99,note:note+' ✗ Already busted'};
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

    if(need===0)return{live_p:100,fair_odd:1.01,note:note+' ✓ Already hit'};
    liveP=_poissonAtLeast(remLam,need)*100;
  }

  return{
    live_p:Math.round(liveP*10)/10,
    fair_odd:Math.round(1/Math.max(liveP/100,0.001)*100)/100,
    note,
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

  const lineKeys = Object.keys(_LINE_STRENGTH_MOD).map(Number);
  const closest = lineKeys.reduce((a, b) => Math.abs(b - favLine) < Math.abs(a - favLine) ? b : a);
  lamFav *= _LINE_STRENGTH_MOD[closest];

  const baseInt = _baseInt2h(curve);
  let elapsed2h, fg2h = favGoals2h, dg2h = dogGoals2h;
  if (matchMinute <= 45) { elapsed2h = 0; fg2h = 0; dg2h = 0; }
  else { elapsed2h = Math.min(45, matchMinute - 45); }
  const itRate = curve[curve.length - 1][2];
  const remInt = _integrateInt(elapsed2h, 45, 2, curve) + itRate * _IT_2H;
  const intFrac = remInt / baseInt;
  const bayMod = 1 - (elapsed2h / 45) * 0.05;

  const bucket = _marginBucket(fg2h - dg2h);
  const remLamFav = lamFav * intFrac * bayMod * _FAV_SCORE_MOD[bucket];
  const remLamDog = lamDog * intFrac * bayMod * _DOG_SCORE_MOD[bucket];

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
// independence assumption as the app.js original.
function computeLiveBtts2H(homeAnchorP, awayAnchorP, minute, favLine, favG2h, dogG2h, favSide, useFlatDecay) {
  const homeRes = computeLiveOdd(homeAnchorP, 'homeScored2H', minute, favLine, favG2h, dogG2h, favSide, useFlatDecay);
  const awayRes = computeLiveOdd(awayAnchorP, 'awayScored2H', minute, favLine, favG2h, dogG2h, favSide, useFlatDecay);
  if (homeRes.live_p == null || awayRes.live_p == null) return null;
  return Math.round(homeRes.live_p * awayRes.live_p) / 100;
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

module.exports = {
  computeLiveOdd, _2H_BETS_SET, _BET_SCORE_MOD_CLASS,
  computeLiveResult2H, computeLiveBtts2H, _2hResultField, _2H_RESULT_KEYS,
};
