// 规则层：季末封存与开季复开的全部业务判定集中在此。
// 纯函数为主，db 由存储层传入；不碰 HTTP，不直接读写文件。

class RuleError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code || 'rule_rejected';
    this.extra = extra; // 例如并发冲突时返回首单 winnerId
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 触发“只转待校准”的阈值
const TEMP_LIMIT = 0.8;       // 温差 > 0.8 ℃
const HUMIDITY_LIMIT = 5;     // 湿度差 > 5 个百分点
const CO2_LIMIT = 100;        // CO2 增量 > 100 ppm
const CHECK_GAP_MIN_HOURS = 24;

// 巡测读数登记时要求齐全的字段（缺项即不得封存）
const SURVEY_READINGS = [
  { field: 'temperature', label: '温度' },
  { field: 'humidity', label: '湿度' },
  { field: 'co2', label: 'CO2' },
  { field: 'dripRate', label: '滴水频率' }
];

// 一个封季包含的三个月（月份从 1 起）
const SEASON_MONTHS = {
  Q1: [1, 2, 3],
  Q2: [4, 5, 6],
  Q3: [7, 8, 9],
  Q4: [10, 11, 12]
};

const SEASON_LABELS = {
  Q1: '一季度（1-3月）',
  Q2: '二季度（4-6月）',
  Q3: '三季度（7-9月）',
  Q4: '四季度（10-12月）'
};

function nowIso(now) {
  return (now || new Date()).toISOString();
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function stamp(action, note, now) {
  return { at: nowIso(now), action, note: note || '' };
}

// ---------- 季节 ----------

function parseSeason(season) {
  const raw = String(season || '');
  const m = /^(\d{4})-(Q[1-4])$/.exec(raw);
  if (!m) throw new RuleError(`季节格式应为 YYYY-Qn，收到：${season}`, 'bad_season');
  return { year: Number(m[1]), quarter: m[2], input: raw };
}

function seasonOfDate(dateInput, now = new Date()) {
  const d = dateInput ? new Date(dateInput) : now;
  if (Number.isNaN(d.getTime())) throw new RuleError('无法解析日期', 'bad_date');
  const month = d.getUTCMonth() + 1;
  const quarter = `Q${Math.ceil(month / 3)}`;
  return `${d.getUTCFullYear()}-${quarter}`;
}

function shiftSeason(season, delta) {
  const { year, quarter } = parseSeason(season);
  const idx = year * 4 + Number(quarter.slice(1)) - 1 + delta;
  return `${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`;
}

function seasonLabel(season) {
  const { year, quarter } = parseSeason(season);
  return `${year}年${SEASON_LABELS[quarter]}`;
}

// ---------- 查询 ----------

function sitesOnRoute(db, route) {
  return (db.sites || []).filter((site) => site.route === route);
}

function activeSealFor(db, siteId, season) {
  return (db.sealOrders || []).find(
    (order) => order.siteId === siteId && order.season === season && order.status === '已封存'
  );
}

function validSurveys(db, siteId, season) {
  const months = SEASON_MONTHS[parseSeason(season).quarter];
  return (db.surveys || []).filter((survey) => {
    if (survey.siteId !== siteId || survey.status === '已撤回') return false;
    return seasonOfDate(survey.date) === season && months.includes(Number(String(survey.date).slice(5, 7)));
  });
}

function missingSurveyReads(survey) {
  return SURVEY_READINGS.filter(({ field }) => survey[field] === '' || survey[field] === null || Number.isNaN(Number(survey[field]))).map(({ label }) => label);
}

// 封存前置条件：本季每月至少一条读数齐全的有效巡测；样点未暂停开放；本季无有效封存单。
function sealingBlockers(db, site, season) {
  const blockers = [];
  if (!site) {
    blockers.push('样点不存在');
    return blockers;
  }
  if (site.protectedStatus === '暂停开放') blockers.push('样点处于暂停开放状态，不得封存');
  const months = SEASON_MONTHS[parseSeason(season).quarter];
  for (const month of months) {
    const monthSurveys = validSurveys(db, site.id, season).filter(
      (survey) => Number(String(survey.date).slice(5, 7)) === month
    );
    if (!monthSurveys.length) {
      blockers.push(`${month}月缺少本季巡测`);
      continue;
    }
    const incomplete = monthSurveys.find((survey) => missingSurveyReads(survey).length);
    if (incomplete) blockers.push(`${month}月巡测存在缺项（${incomplete.date} ${missingSurveyReads(incomplete).join('、')}）`);
  }
  return blockers;
}

function activeChecks(db, siteId, season) {
  return (db.reopenChecks || []).filter(
    (check) => check.siteId === siteId && check.season === season && check.status !== '已撤回'
  );
}

// 同一开季内复测人的两次有效测量（互不为同人、间隔 ≥24h）
function checkPair(db, siteId, season) {
  const checks = activeChecks(db, siteId, season)
    .slice()
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
  for (let i = 0; i < checks.length; i++) {
    for (let j = i + 1; j < checks.length; j++) {
      const [a, b] = [checks[i], checks[j]];
      if (a.surveyor === b.surveyor) continue;
      if (new Date(b.measuredAt) - new Date(a.measuredAt) >= CHECK_GAP_MIN_HOURS * 60 * 60 * 1000) {
        return [a, b];
      }
    }
  }
  return null;
}

function pairVerdict(first, second, site) {
  // 容差吸收 16.8-16.0 这类十进制浮点误差，保证“恰好等于阈值不超”
  const eps = 1e-9;
  const tempGap = Math.abs(Number(second.temperature) - Number(first.temperature));
  const humidGap = Math.abs(Number(second.humidity) - Number(first.humidity));
  const co2Delta = Number(second.co2) - Number(first.co2);
  const reasons = [];
  if (tempGap > TEMP_LIMIT + eps) reasons.push(`温差 ${tempGap.toFixed(2)}℃ 超 0.8℃`);
  if (humidGap > HUMIDITY_LIMIT + eps) reasons.push(`湿度差 ${humidGap.toFixed(1)} 个百分点超 5`);
  if (co2Delta > CO2_LIMIT + eps) reasons.push(`CO2 增量 ${co2Delta.toFixed(0)}ppm 超 100ppm`);
  return {
    qualified: reasons.length === 0,
    reasons,
    tempGap: Number(tempGap.toFixed(2)),
    humidGap: Number(humidGap.toFixed(1)),
    co2Delta: Number(co2Delta.toFixed(0)),
    baselineSeason: site ? seasonOfDate(site.baselineUpdatedAt || site.createdAt) : null
  };
}

// ---------- 单：封存 ----------

function createSealOrder(db, input = {}, now = new Date()) {
  const season = parseSeason(input.season).input;
  const site = (db.sites || []).find((entry) => entry.id === input.siteId);
  if (!site) throw new RuleError('未找到样点，无法封存', 'site_missing');
  if (!input.operator) throw new RuleError('封存负责人必填', 'operator_required');

  // 唯一性先判：每样点每季仅一张有效封存单，并发只认首单
  const winner = activeSealFor(db, site.id, season);
  if (winner) {
    throw new RuleError(`${seasonLabel(season)} 已存在封存单（编号 ${winner.id}），并发只认首单`, 'seal_exists', { winnerId: winner.id });
  }

  const blockers = sealingBlockers(db, site, season);
  if (blockers.length) throw new RuleError(blockers.join('；'), 'seal_blocked');

  const at = nowIso(now);
  const order = {
    id: newId('seal'),
    siteId: site.id,
    route: site.route,
    season,
    operator: input.operator,
    sealedDate: input.sealedDate || now.toISOString().slice(0, 10),
    status: '已封存',
    note: input.note || '',
    createdAt: at,
    updatedAt: at,
    history: [stamp('封存', `季末封存：${seasonLabel(season)}，本季巡测已补齐`, now)]
  };
  db.sealOrders.push(order);

  site.updatedAt = at;
  site.history = site.history || [];
  site.history.unshift(stamp('封存', `${seasonLabel(season)}封存单 ${order.id}`, now));
  return order;
}

// ---------- 单：开季复测 ----------

function refreshCalibration(db, site, season, now) {
  const pair = checkPair(db, site.id, season);
  if (!pair) {
    if (site.calibrationSeason === season) {
      site.calibrationStatus = '';
      site.calibrationReason = '';
      site.calibrationSeason = '';
    }
    return null;
  }
  const verdict = pairVerdict(pair[0], pair[1], site);
  const at = nowIso(now);
  if (!verdict.qualified) {
    site.calibrationStatus = '待校准';
    site.calibrationReason = verdict.reasons.join('｜');
    site.calibrationSeason = season;
    site.updatedAt = at;
    site.history = site.history || [];
    site.history.unshift(stamp('待校准', `${seasonLabel(season)}开季复测：${verdict.reasons.join('；')}`, now));
  } else if (site.calibrationSeason === season && site.calibrationStatus === '待校准') {
    // 旧的不合规复测撤回后，新组合合规：解除待校准
    site.calibrationStatus = '';
    site.calibrationReason = '';
    site.calibrationSeason = '';
    site.updatedAt = at;
    site.history = site.history || [];
    site.history.unshift(stamp('复测合格', `${seasonLabel(season)}复测组合合规，解除待校准`, now));
  }
  return verdict;
}

function addReopenCheck(db, input = {}, now = new Date()) {
  const season = parseSeason(input.season).input;
  const site = (db.sites || []).find((entry) => entry.id === input.siteId);
  if (!site) throw new RuleError('未找到样点', 'site_missing');
  if (!input.surveyor) throw new RuleError('复测人员必填', 'surveyor_required');
  if (input.temperature === undefined || input.humidity === undefined || input.co2 === undefined) {
    throw new RuleError('温度、湿度、CO2 必填', 'reading_required');
  }
  if (site.protectedStatus === '暂停开放') throw new RuleError('样点暂停开放，不得登记开季复测', 'site_closed');

  const measuredAt = input.measuredAt || nowIso(now);
  if (Number.isNaN(new Date(measuredAt).getTime())) throw new RuleError('测量时间无法解析', 'bad_time');

  const checks = activeChecks(db, site.id, season);
  if (checks.length >= 2) {
    const pair = checkPair(db, site.id, season);
    throw new RuleError(
      pair ? '该样点两人复测已齐（间隔≥24小时）' : '该样点本季已有两条复测记录；如需重测请先撤回不合规记录',
      'checks_full'
    );
  }
  for (const check of checks) {
    if (check.surveyor === input.surveyor) {
      throw new RuleError('两次复测须由不同人员完成，该人员本季已登记一次', 'same_surveyor');
    }
    const gapHours = Math.abs(new Date(measuredAt) - new Date(check.measuredAt)) / 3600000;
    if (gapHours < CHECK_GAP_MIN_HOURS) {
      throw new RuleError(`两次测量须间隔至少 24 小时，当前间隔 ${gapHours.toFixed(1)} 小时`, 'gap_too_short');
    }
  }

  const at = nowIso(now);
  const check = {
    id: newId('check'),
    siteId: site.id,
    route: site.route,
    season,
    surveyor: input.surveyor,
    measuredAt,
    temperature: Number(input.temperature),
    humidity: Number(input.humidity),
    co2: Number(input.co2),
    status: '有效',
    note: input.note || '',
    createdAt: at,
    updatedAt: at,
    history: [stamp('登记复测', `${seasonLabel(season)}开季复测，${input.surveyor}`, now)]
  };
  db.reopenChecks.push(check);

  const verdict = refreshCalibration(db, site, season, now);
  if (verdict && !verdict.qualified) {
    check.verdict = '待校准';
    check.verdictReason = verdict.reasons.join('｜');
  }
  return check;
}

function withdrawCheck(db, checkId, input = {}, now = new Date()) {
  const check = (db.reopenChecks || []).find((entry) => entry.id === checkId);
  if (!check) throw new RuleError('未找到复测记录', 'check_missing');
  if (check.status === '已撤回') throw new RuleError('该复测记录已撤回', 'already_withdrawn');
  const at = nowIso(now);
  const { season, siteId, route } = check;
  check.status = '已撤回';
  check.updatedAt = at;
  check.history = check.history || [];
  check.history.unshift(stamp('撤回复测', input.reason || '原结论失效', now));

  // 撤回复测让原结论失效：对应路线复开单失效，待校准状态按剩余记录重算
  invalidateReopenOrders(db, (order) =>
    order.route === route && order.season === season && order.status === '已复开',
    `复测记录 ${check.id} 被撤回，原复开结论失效`, now);

  const site = (db.sites || []).find((entry) => entry.id === siteId);
  if (site) refreshCalibration(db, site, season, now);
  return check;
}

// ---------- 单：路线复开 ----------

function reopenEvaluation(db, route, season) {
  const sites = sitesOnRoute(db, route);
  if (!sites.length) throw new RuleError(`路线“${route}”内没有样点`, 'route_empty');
  const prevSeason = shiftSeason(season, -1);
  const rows = sites.map((site) => {
    const row = { site, blockers: [], pair: null, verdict: null };
    if (site.protectedStatus === '暂停开放') row.blockers.push('暂停开放');
    if (site.calibrationSeason === season && site.calibrationStatus === '待校准') {
      row.blockers.push(`待校准（${site.calibrationReason || '复测超阈值'}）`);
    }
    if (!activeSealFor(db, site.id, prevSeason)) row.blockers.push(`上一季（${seasonLabel(prevSeason)}）未封存`);
    const pair = checkPair(db, site.id, season);
    if (!pair) {
      row.blockers.push('缺少两人隔24小时的复测');
    } else {
      row.pair = pair;
      row.verdict = pairVerdict(pair[0], pair[1], site);
      if (!row.verdict.qualified) row.blockers.push(`复测超阈值（${row.verdict.reasons.join('；')}）`);
    }
    return row;
  });
  const blocked = rows.filter((row) => row.blockers.length);
  return {
    season,
    prevSeason,
    sites: rows,
    allowed: blocked.length === 0,
    blockedSites: blocked
  };
}

function activeReopenOrder(db, route, season) {
  return (db.reopenOrders || []).find(
    (order) => order.route === route && order.season === season && order.status === '已复开'
  );
}

function reopenRoute(db, input = {}, now = new Date()) {
  const season = parseSeason(input.season).input;
  const { route } = input;
  if (!route) throw new RuleError('路线必填', 'route_required');
  if (!input.operator) throw new RuleError('复开负责人必填', 'operator_required');

  const winner = activeReopenOrder(db, route, season);
  if (winner) throw new RuleError(`路线“${route}”${seasonLabel(season)}已有复开单（${winner.id}）`, 'reopen_exists', { winnerId: winner.id });

  const evaluation = reopenEvaluation(db, route, season);
  const at = nowIso(now);
  const base = {
    id: newId('reopen'),
    route,
    season,
    operator: input.operator,
    note: input.note || '',
    createdAt: at,
    updatedAt: at
  };

  if (!evaluation.allowed) {
    // 只转待校准 / 缺项：整条路线不得复开；旧的“不予复开”结论可被新一轮评审覆盖
    const prior = (db.reopenOrders || []).find(
      (order) => order.route === route && order.season === season && order.status === '不予复开'
    );
    const detail = evaluation.blockedSites
      .map((row) => `${row.site.pointCode}：${row.blockers.join('、')}`)
      .join('；');
    if (prior) {
      prior.status = '不予复开';
      prior.updatedAt = at;
      prior.history = prior.history || [];
      prior.history.unshift(stamp('复开评审', `复审仍不予复开：${detail}`, now));
      prior.evaluation = evaluationSummary(evaluation);
      return prior;
    }
    const order = {
      ...base,
      status: '不予复开',
      history: [stamp('复开评审', `整条路线不得复开：${detail}`, now)],
      evaluation: evaluationSummary(evaluation)
    };
    db.reopenOrders.push(order);
    return order;
  }

  const order = {
    ...base,
    status: '已复开',
    reopenedDate: input.reopenedDate || now.toISOString().slice(0, 10),
    history: [stamp('复开', `${seasonLabel(season)}开季复开，路线内 ${evaluation.sites.length} 个样点复测全部合规`, now)],
    evaluation: evaluationSummary(evaluation)
  };
  db.reopenOrders.push(order);

  for (const row of evaluation.sites) {
    row.site.updatedAt = at;
    row.site.history = row.site.history || [];
    row.site.history.unshift(stamp('复开', `路线“${route}”${seasonLabel(season)}复开`, now));
  }
  return order;
}

function evaluationSummary(evaluation) {
  return {
    allowed: evaluation.allowed,
    sites: evaluation.sites.map((row) => ({
      siteId: row.site.id,
      pointCode: row.site.pointCode,
      blockers: row.blockers,
      tempGap: row.verdict?.tempGap ?? null,
      humidGap: row.verdict?.humidGap ?? null,
      co2Delta: row.verdict?.co2Delta ?? null
    }))
  };
}

function invalidateReopenOrders(db, predicate, reason, now) {
  const invalidated = [];
  for (const order of db.reopenOrders || []) {
    if (order.status !== '已复开') continue;
    if (!predicate(order)) continue;
    order.status = '结论失效';
    order.updatedAt = nowIso(now);
    order.history = order.history || [];
    order.history.unshift(stamp('结论失效', reason, now));
    invalidated.push(order);
  }
  return invalidated;
}

// ---------- 结论失效的三个来源 ----------

// 修订基准：patch 为上层在赋值前比对出的实际变更项。
// 样点当季及以后的封存单失效（封存依据的读数偏离基准随之重估），
// 并让涉及该样点路线的全部有效复开结论失效。
function reviseBaseline(db, site, patch, now) {
  const fields = ['baselineTemp', 'baselineHumidity', 'baselineCo2'];
  const changed = fields.filter((field) => patch[field] !== undefined);
  if (!changed.length) return { changed: [], seals: [], reopens: [] };
  const at = nowIso(now);
  const labels = { baselineTemp: '基准温度', baselineHumidity: '基准湿度', baselineCo2: '基准CO2' };

  const seals = [];
  for (const order of db.sealOrders || []) {
    if (order.siteId !== site.id || order.status !== '已封存') continue;
    order.status = '结论失效';
    order.updatedAt = at;
    order.history = order.history || [];
    order.history.unshift(stamp('结论失效', `样点修订${changed.map((f) => labels[f]).join('、')}，封存原结论失效`, now));
    seals.push(order);
  }

  const reopens = invalidateReopenOrders(
    db,
    (order) => (order.evaluation?.sites || []).some((row) => row.siteId === site.id),
    `样点 ${site.pointCode} 修订基准，路线复开原结论失效`,
    now
  );

  site.baselineUpdatedAt = at;
  return { changed, seals, reopens };
}

// 撤回巡测：让该样点该季封存结论失效；若撤回的是开季复测，另有规则处理。
function withdrawSurvey(db, survey, input = {}, now = new Date()) {
  if (survey.status === '已撤回') throw new RuleError('该巡测已撤回', 'already_withdrawn');
  const at = nowIso(now);
  survey.status = '已撤回';
  survey.updatedAt = at;
  survey.history = survey.history || [];
  survey.history.unshift(stamp('撤回巡测', input.reason || '原结论失效', now));

  const season = seasonOfDate(survey.date, now);
  const seals = [];
  const order = activeSealFor(db, survey.siteId, season);
  if (order) {
    order.status = '结论失效';
    order.updatedAt = at;
    order.history = order.history || [];
    order.history.unshift(stamp('结论失效', `巡测 ${survey.date} 被撤回，本季巡测不再齐全，封存原结论失效`, now));
    seals.push(order);
  }

  const site = (db.sites || []).find((entry) => entry.id === survey.siteId);
  if (site) {
    site.updatedAt = at;
    site.history = site.history || [];
    site.history.unshift(stamp('撤回巡测', `${survey.date} 巡测撤回`, now));
  }
  return { survey, seals };
}

// 巡测读数被改写：封存结论依据的数据已变，原结论失效
function surveyReadingChanged(db, survey, changedFields, now) {
  if (!changedFields.length) return [];
  const season = seasonOfDate(survey.date, now);
  const order = activeSealFor(db, survey.siteId, season);
  if (!order) return [];
  order.status = '结论失效';
  order.updatedAt = nowIso(now);
  order.history = order.history || [];
  order.history.unshift(stamp('结论失效', `巡测 ${survey.date} 的${changedFields.join('、')}被修订，封存原结论失效`, now));
  return [order];
}

// 样点改挂路线：旧路线与新路线的复开结论都不再可靠
function siteRouteChanged(db, site, oldRoute, now) {
  if (!oldRoute || oldRoute === site.route) return [];
  return invalidateReopenOrders(
    db,
    (order) => order.route === oldRoute || order.route === site.route,
    `样点 ${site.pointCode} 路线由“${oldRoute}”调整为“${site.route}”，复开原结论失效`,
    now
  );
}

module.exports = {
  RuleError,
  TEMP_LIMIT,
  HUMIDITY_LIMIT,
  CO2_LIMIT,
  CHECK_GAP_MIN_HOURS,
  SURVEY_READINGS,
  parseSeason,
  seasonOfDate,
  shiftSeason,
  seasonLabel,
  sitesOnRoute,
  activeSealFor,
  validSurveys,
  missingSurveyReads,
  sealingBlockers,
  activeChecks,
  checkPair,
  pairVerdict,
  createSealOrder,
  addReopenCheck,
  withdrawCheck,
  reopenEvaluation,
  activeReopenOrder,
  reopenRoute,
  invalidateReopenOrders,
  reviseBaseline,
  withdrawSurvey,
  surveyReadingChanged,
  siteRouteChanged,
  stamp,
  newId
};
