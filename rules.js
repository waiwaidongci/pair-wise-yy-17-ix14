'use strict';

// 季节平台规则层：封存、复测、待校准、复开、结论失效的全部判定逻辑。
// 只依赖传入的 db 对象，不触碰存储与页面，保证规则/存储/页面分离。

const THRESHOLDS = {
  tempDiff: 0.8, // 两人复测温差上限（℃）
  humidityDiff: 5, // 湿度差上限（个百分点）
  co2Rise: 100, // CO2 增量上限（ppm）
  gapHours: 24 // 两人复测最小间隔（小时）
};

const SURVEY_REQUIRED_FIELDS = ['temperature', 'humidity', 'co2', 'dripRate'];
const BASELINE_FIELDS = ['baselineTemp', 'baselineHumidity', 'baselineCo2'];
const SEASON_COLLECTIONS = ['sealOrders', 'rechecks', 'calibrations', 'routeReopens'];

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function seasonOf(dateInput) {
  let d;
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    const [y, m, day] = dateInput.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(dateInput);
  }
  if (Number.isNaN(d.getTime())) return '未知季节';
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function currentSeason(now = new Date()) {
  return seasonOf(now);
}

function isWithdrawn(survey) {
  return survey.status === '已撤回';
}

function missingSurveyFields(survey) {
  return SURVEY_REQUIRED_FIELDS.filter((field) => survey[field] === undefined || survey[field] === null || survey[field] === '');
}

function seasonSurveys(db, siteId, season) {
  return (db.surveys || []).filter((survey) => survey.siteId === siteId && !isWithdrawn(survey) && seasonOf(survey.date) === season);
}

function activeSeal(db, siteId, season) {
  return (db.sealOrders || []).find((order) => order.siteId === siteId && order.season === season && order.status === '已封存') || null;
}

// 封存门槛：暂停开放不得封存；本季巡测须补齐且不缺项；每点每季仅一张有效封存单。
function sealBlockers(db, site, season) {
  if (!site) return ['样点不存在'];
  const reasons = [];
  if (site.protectedStatus === '暂停开放') reasons.push('样点暂停开放，不得封存');
  const surveys = seasonSurveys(db, site.id, season);
  if (!surveys.length) reasons.push(`${season} 巡测未补齐`);
  if (surveys.some((survey) => missingSurveyFields(survey).length)) reasons.push('本季巡测缺项（温度/湿度/CO2/滴水频率）');
  if (activeSeal(db, site.id, season)) reasons.push('本季已存在封存单，仅首单有效');
  return reasons;
}

function siteRechecks(db, siteId, season) {
  return (db.rechecks || [])
    .filter((entry) => entry.siteId === siteId && entry.season === season)
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
}

// 有效复测对：两名不同人员、间隔不少于 24 小时。
function validPairs(rechecks) {
  const pairs = [];
  for (let i = 0; i < rechecks.length; i++) {
    for (let j = i + 1; j < rechecks.length; j++) {
      const earlier = rechecks[i];
      const later = rechecks[j];
      if (earlier.surveyor === later.surveyor) continue;
      const gapHours = (new Date(later.measuredAt) - new Date(earlier.measuredAt)) / 36e5;
      if (gapHours < THRESHOLDS.gapHours) continue;
      pairs.push([earlier, later]);
    }
  }
  pairs.sort((a, b) => new Date(a[1].measuredAt) - new Date(b[1].measuredAt));
  return pairs;
}

// 超阈值判定：温差 > 0.8℃、湿度差 > 5 个百分点、CO2 增量 > 100ppm。
function pairBreaches(pair) {
  const [earlier, later] = pair;
  const breaches = [];
  const tempDiff = Math.abs(Number(earlier.temperature) - Number(later.temperature));
  const humidityDiff = Math.abs(Number(earlier.humidity) - Number(later.humidity));
  const co2Rise = Number(later.co2) - Number(earlier.co2);
  if (tempDiff > THRESHOLDS.tempDiff) breaches.push(`温差 ${tempDiff.toFixed(2)}℃ 超 ${THRESHOLDS.tempDiff}℃`);
  if (humidityDiff > THRESHOLDS.humidityDiff) breaches.push(`湿度差 ${humidityDiff} 个百分点超 ${THRESHOLDS.humidityDiff}`);
  if (co2Rise > THRESHOLDS.co2Rise) breaches.push(`CO2 增量 ${co2Rise}ppm 超 ${THRESHOLDS.co2Rise}ppm`);
  return breaches;
}

function openCalibration(db, siteId, season) {
  return (db.calibrations || []).find((entry) => entry.siteId === siteId && entry.season === season && entry.status === '待校准') || null;
}

function recheckEvaluation(db, siteId, season) {
  const list = siteRechecks(db, siteId, season);
  const pairs = validPairs(list);
  const passing = pairs.filter((pair) => pairBreaches(pair).length === 0);
  const open = openCalibration(db, siteId, season);
  let status;
  if (open) status = '待校准';
  else if (passing.length) status = '复测合格';
  else if (pairs.length) status = '待校准';
  else if (list.length) status = '复测中';
  else status = '未复测';
  return {
    status,
    list,
    pairs,
    passing,
    latestPair: pairs[pairs.length - 1] || null,
    openCalibration: open
  };
}

// 复测登记后校准单联动：最新有效对超阈值只转待校准；出现合格对则校准闭环。
function syncCalibrations(db, site, season) {
  const evaluation = recheckEvaluation(db, site.id, season);
  const open = evaluation.openCalibration;
  if (open) {
    if (evaluation.passing.length) {
      open.status = '已校准';
      open.updatedAt = new Date().toISOString();
      open.history = open.history || [];
      open.history.unshift(stamp('校准闭环', '复测合格，校准闭环'));
      site.history = site.history || [];
      site.history.unshift(stamp('校准闭环', `${season} 复测合格`));
      site.updatedAt = new Date().toISOString();
    }
    return;
  }
  if (!evaluation.latestPair) return;
  const breaches = pairBreaches(evaluation.latestPair);
  if (!breaches.length) return;
  const now = new Date().toISOString();
  db.calibrations.push({
    id: `calibrations-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId: site.id,
    route: site.route,
    season,
    reasons: breaches,
    status: '待校准',
    createdAt: now,
    updatedAt: now,
    history: [stamp('转待校准', breaches.join('；'))]
  });
  site.history = site.history || [];
  site.history.unshift(stamp('转待校准', breaches.join('；')));
  site.updatedAt = now;
}

// 结论失效：基准修订或巡测撤回时，本季有效封存单转为已失效。
function invalidateSeals(db, siteId, season, reason) {
  const affected = (db.sealOrders || []).filter((order) => order.siteId === siteId && order.season === season && order.status === '已封存');
  const now = new Date().toISOString();
  for (const order of affected) {
    order.status = '已失效';
    order.updatedAt = now;
    order.history = order.history || [];
    order.history.unshift(stamp('结论失效', reason));
  }
  if (affected.length) {
    const site = (db.sites || []).find((entry) => entry.id === siteId);
    if (site) {
      site.history = site.history || [];
      site.history.unshift(stamp('封存失效', reason));
      site.updatedAt = now;
    }
  }
  return affected.length;
}

function baselineChanged(site, values) {
  return BASELINE_FIELDS.some((field) => values[field] !== undefined && values[field] !== null && Number(values[field]) !== Number(site[field]));
}

function applyBaselineRevision(db, site, values, note) {
  for (const field of BASELINE_FIELDS) {
    if (values[field] !== undefined && values[field] !== null) site[field] = Number(values[field]);
  }
  site.updatedAt = new Date().toISOString();
  site.history = site.history || [];
  site.history.unshift(stamp('基准修订', note || '修订基准值'));
  const invalidated = invalidateSeals(db, site.id, currentSeason(), '基准修订，原封存结论失效');
  return { invalidated };
}

function withdrawSurvey(db, survey, note) {
  survey.status = '已撤回';
  survey.updatedAt = new Date().toISOString();
  survey.history = survey.history || [];
  survey.history.unshift(stamp('巡测撤回', note || '巡测记录撤回'));
  const season = seasonOf(survey.date);
  const invalidated = invalidateSeals(db, survey.siteId, season, '巡测撤回，原封存结论失效');
  return { invalidated, season };
}

function siteLabel(site) {
  return site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : '未知样点';
}

function recheckNote(evaluation) {
  if (evaluation.status === '复测合格') return '两人复测结果在阈值内';
  if (evaluation.status === '待校准') {
    const reasons = evaluation.openCalibration ? evaluation.openCalibration.reasons : [];
    return reasons.length ? reasons.join('；') : '复测超阈值，待校准';
  }
  if (evaluation.status === '复测中') return `需两名不同人员各测一次且间隔≥${THRESHOLDS.gapHours}小时`;
  return '尚未登记复测';
}

function buildHistoryFeed(db) {
  const sitesById = Object.fromEntries((db.sites || []).map((site) => [site.id, site]));
  const feed = [];
  const push = (entity, label, entry) => feed.push({ at: entry.at, entity, label, action: entry.action, note: entry.note || '' });
  for (const site of db.sites || []) {
    for (const entry of site.history || []) push('样点', site.pointCode, entry);
  }
  for (const survey of db.surveys || []) {
    const site = sitesById[survey.siteId];
    for (const entry of survey.history || []) push('巡测', `${site ? site.pointCode : survey.siteId} ${survey.surveyor}`, entry);
  }
  for (const order of db.sealOrders || []) {
    const site = sitesById[order.siteId];
    for (const entry of order.history || []) push('封存单', `${site ? site.pointCode : order.siteId} ${order.season}`, entry);
  }
  for (const recheck of db.rechecks || []) {
    const site = sitesById[recheck.siteId];
    for (const entry of recheck.history || []) push('复测', `${site ? site.pointCode : recheck.siteId} ${recheck.surveyor}`, entry);
  }
  for (const calibration of db.calibrations || []) {
    const site = sitesById[calibration.siteId];
    for (const entry of calibration.history || []) push('校准', site ? site.pointCode : calibration.siteId, entry);
  }
  for (const reopen of db.routeReopens || []) {
    for (const entry of reopen.history || []) push('路线', reopen.route, entry);
  }
  return feed.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 50);
}

// 路线/待校准清单/履历的总览，全部由同一份数据派生，保证三者一致。
function buildOverview(db, season = currentSeason()) {
  const sites = db.sites || [];
  const sitesById = Object.fromEntries(sites.map((site) => [site.id, site]));
  const routeNames = [...new Set(sites.map((site) => site.route).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  const routes = routeNames.map((route) => {
    const routeSites = sites
      .filter((site) => site.route === route)
      .sort((a, b) => String(a.pointCode).localeCompare(String(b.pointCode), 'zh'));
    const reopen = (db.routeReopens || []).find((entry) => entry.route === route && entry.season === season && entry.status === '已复开') || null;
    const rows = routeSites.map((site) => {
      const seals = (db.sealOrders || [])
        .filter((order) => order.siteId === site.id && order.season === season)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const active = seals.find((order) => order.status === '已封存') || null;
      const evaluation = recheckEvaluation(db, site.id, season);
      return {
        id: site.id,
        pointCode: site.pointCode,
        cave: site.cave,
        zone: site.zone,
        protectedStatus: site.protectedStatus,
        sealState: active ? '已封存' : seals.length ? '已失效' : '未封存',
        sealBlockers: active ? [] : sealBlockers(db, site, season),
        recheckStatus: evaluation.status,
        recheckNote: recheckNote(evaluation),
        rechecks: evaluation.list
      };
    });
    const reopenBlockers = rows.filter((row) => row.recheckStatus !== '复测合格').map((row) => `${row.pointCode} ${row.recheckStatus}`);
    return { route, season, reopen, sites: rows, reopenBlockers };
  });
  const calibrations = (db.calibrations || [])
    .map((entry) => ({ ...entry, siteLabel: siteLabel(sitesById[entry.siteId]) }))
    .sort((a, b) => (a.status === b.status ? new Date(b.updatedAt) - new Date(a.updatedAt) : a.status === '待校准' ? -1 : 1));
  const seals = (db.sealOrders || [])
    .map((entry) => ({ ...entry, siteLabel: siteLabel(sitesById[entry.siteId]) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { season, thresholds: THRESHOLDS, routes, calibrations, seals, history: buildHistoryFeed(db) };
}

module.exports = {
  THRESHOLDS,
  SURVEY_REQUIRED_FIELDS,
  BASELINE_FIELDS,
  SEASON_COLLECTIONS,
  stamp,
  seasonOf,
  currentSeason,
  missingSurveyFields,
  seasonSurveys,
  activeSeal,
  sealBlockers,
  siteRechecks,
  validPairs,
  pairBreaches,
  openCalibration,
  recheckEvaluation,
  syncCalibrations,
  invalidateSeals,
  baselineChanged,
  applyBaselineRevision,
  withdrawSurvey,
  buildOverview
};
