const express = require('express');
const path = require('path');

const config = require('./project.config');
const store = require('./store');
const rules = require('./rules');

const PORT = process.env.PORT || config.port || 3900;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function stamp(action, note) {
  return rules.stamp(action, note);
}

// 规则层错误统一转 409（并发冲突/条件不满足），其余 400
function fail(res, error) {
  if (error instanceof rules.RuleError) {
    return res.status(409).json({ error: error.message, code: error.code, ...error.extra });
  }
  return res.status(400).json({ error: error.message || '请求不合法' });
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

// 页面用的元数据：当前季、相邻季、路线清单
app.get('/api/meta', async (req, res) => {
  const db = await store.readDb();
  const current = rules.seasonOfDate(null, new Date());
  const routes = [...new Set((db.sites || []).map((site) => site.route).filter(Boolean))].sort();
  res.json({
    current,
    prev: rules.shiftSeason(current, -1),
    next: rules.shiftSeason(current, 1),
    seasons: [
      { value: rules.shiftSeason(current, -1), label: rules.seasonLabel(rules.shiftSeason(current, -1)) },
      { value: current, label: `${rules.seasonLabel(current)}（当前季）` },
      { value: rules.shiftSeason(current, 1), label: rules.seasonLabel(rules.shiftSeason(current, 1)) }
    ],
    routes,
    thresholds: {
      temp: rules.TEMP_LIMIT,
      humidity: rules.HUMIDITY_LIMIT,
      co2: rules.CO2_LIMIT,
      gapHours: rules.CHECK_GAP_MIN_HOURS
    },
    pendingCalibration: (db.sites || [])
      .filter((site) => site.calibrationStatus === '待校准')
      .map((site) => ({
        siteId: site.id,
        pointCode: site.pointCode,
        cave: site.cave,
        zone: site.zone,
        route: site.route,
        season: site.calibrationSeason,
        reason: site.calibrationReason || ''
      }))
  });
});

app.get('/api/db', async (req, res) => {
  const db = await store.readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// ---------- 通用建档（样点、巡测仍走配置化表单） ----------

app.post('/api/:collection', async (req, res, next) => {
  const { collection } = req.params;
  // 领域流程路径由后面的专用端点处理
  if (['seals', 'reopen-checks', 'reopen-orders'].includes(collection)) return next('route');
  if (!store.COLLECTIONS.includes(collection)) return res.status(404).json({ error: 'unknown collection' });
  // 封存单 / 复测 / 复开单必须走领域端点，避免绕过规则
  if (['sealOrders', 'reopenChecks', 'reopenOrders'].includes(collection)) {
    return res.status(405).json({ error: '该集合需通过专用流程端点创建' });
  }
  try {
    const item = await store.mutate((db) => {
      const now = new Date();
      const created = {
        id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        ...req.body,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        history: [stamp('创建', req.body.note || req.body.memo || '')]
      };
      db[collection].push(created);
      return created;
    });
    res.status(201).json(item);
  } catch (error) {
    fail(res, error);
  }
});

// ---------- 通用更新（含基准修订的规则联动） ----------

app.patch('/api/:collection/:id', async (req, res) => {
  const { collection, id } = req.params;
  if (!store.COLLECTIONS.includes(collection)) return res.status(404).json({ error: 'unknown collection' });
  const body = { ...req.body };
  const historyAction = body.historyAction;
  delete body.historyAction;
  try {
    const item = await store.mutate((db) => {
      const target = db[collection]?.find((entry) => entry.id === id);
      if (!target) throw new rules.RuleError('not found', 'not_found');
      const now = new Date();

      if (collection === 'sites') {
        const oldRoute = target.route;
        // 修订基准须在赋值前比对新旧值，否则检测不到变化
        const baselinePatch = {};
        for (const field of ['baselineTemp', 'baselineHumidity', 'baselineCo2']) {
          if (body[field] !== undefined && Number(body[field]) !== Number(target[field])) {
            baselinePatch[field] = Number(body[field]);
          }
        }
        Object.assign(target, body, { updatedAt: now.toISOString() });
        rules.reviseBaseline(db, target, baselinePatch, now);
        rules.siteRouteChanged(db, target, oldRoute, now);
      } else if (collection === 'surveys') {
        const readingFields = rules.SURVEY_READINGS.map((entry) => entry.field);
        const changed = readingFields.filter(
          (field) => body[field] !== undefined && Number(body[field]) !== Number(target[field])
        );
        Object.assign(target, body, { updatedAt: now.toISOString() });
        rules.surveyReadingChanged(db, target, changed, now);
      } else if (collection === 'sealOrders' || collection === 'reopenOrders') {
        // 状态只允许规则流转，前端不能直接改写
        delete body.status;
        Object.assign(target, body, { updatedAt: now.toISOString() });
      } else {
        Object.assign(target, body, { updatedAt: now.toISOString() });
      }

      target.history = target.history || [];
      if (historyAction || body.note || body.memo || body.status) {
        target.history.unshift(stamp(historyAction || body.status || '更新', body.note || body.memo || ''));
      }
      return target;
    });
    res.json(item);
  } catch (error) {
    if (error.code === 'not_found') return res.status(404).json({ error: 'not found' });
    return fail(res, error);
  }
});

app.delete('/api/:collection/:id', async (req, res) => {
  const { collection, id } = req.params;
  if (!store.COLLECTIONS.includes(collection)) return res.status(404).json({ error: 'unknown collection' });
  if (collection === 'reopenChecks' || collection === 'reopenOrders') {
    return res.status(405).json({ error: '复测与复开单只能撤回/失效，不能删除' });
  }
  try {
    await store.mutate((db) => {
      if (!Array.isArray(db[collection])) throw new rules.RuleError('unknown collection', 'unknown');
      const item = db[collection].find((entry) => entry.id === id);
      if (!item) throw new rules.RuleError('not found', 'not_found');
      if (collection === 'sites') {
        if ((db.sealOrders || []).some((order) => order.siteId === id && order.status === '已封存')) {
          throw new rules.RuleError('该样点存在有效封存单，不能删除；如信息有误请先处理封存单', 'site_in_use');
        }
      }
      if (collection === 'surveys') {
        // 删除与撤回等效：先按撤回规则让封存结论失效，再移除记录
        rules.withdrawSurvey(db, item, { reason: '记录删除' }, new Date());
      }
      db[collection] = db[collection].filter((entry) => entry.id !== id);
    });
    res.status(204).end();
  } catch (error) {
    if (error.code === 'not_found') return res.status(404).json({ error: 'not found' });
    return fail(res, error);
  }
});

// ---------- 领域流程端点 ----------

// 季末封存
app.post('/api/seals', async (req, res) => {
  try {
    const order = await store.mutate((db) => rules.createSealOrder(db, req.body, new Date()));
    res.status(201).json(order);
  } catch (error) {
    fail(res, error);
  }
});

// 开季复测登记
app.post('/api/reopen-checks', async (req, res) => {
  try {
    const check = await store.mutate((db) => rules.addReopenCheck(db, req.body, new Date()));
    res.status(201).json(check);
  } catch (error) {
    fail(res, error);
  }
});

// 撤回复测（原结论失效）
app.post('/api/reopen-checks/:id/withdraw', async (req, res) => {
  try {
    const check = await store.mutate((db) => rules.withdrawCheck(db, req.params.id, req.body || {}, new Date()));
    res.json(check);
  } catch (error) {
    fail(res, error);
  }
});

// 路线复开评审（不产生单据，给页面预览每点阻断原因）
app.get('/api/routes/:route/reopen-evaluation', async (req, res) => {
  try {
    const db = await store.readDb();
    const season = req.query.season || rules.seasonOfDate(null, new Date());
    const evaluation = rules.reopenEvaluation(db, req.params.route, season);
    res.json({
      route: req.params.route,
      season,
      allowed: evaluation.allowed,
      sites: evaluation.sites.map((row) => ({
        siteId: row.site.id,
        pointCode: row.site.pointCode,
        zone: row.site.zone,
        protectedStatus: row.site.protectedStatus,
        blockers: row.blockers,
        pair: row.pair ? row.pair.map((check) => ({ id: check.id, surveyor: check.surveyor, measuredAt: check.measuredAt })) : null,
        verdict: row.verdict
      }))
    });
  } catch (error) {
    fail(res, error);
  }
});

// 路线复开 / 不予复开立单
app.post('/api/reopen-orders', async (req, res) => {
  try {
    const order = await store.mutate((db) => rules.reopenRoute(db, req.body, new Date()));
    res.status(201).json(order);
  } catch (error) {
    fail(res, error);
  }
});

// 撤回巡测（配置化动作按钮触发）
app.post('/api/surveys/:id/withdraw', async (req, res) => {
  try {
    const result = await store.mutate((db) => {
      const survey = db.surveys?.find((entry) => entry.id === req.params.id);
      if (!survey) throw new rules.RuleError('not found', 'not_found');
      return rules.withdrawSurvey(db, survey, req.body || {}, new Date());
    });
    res.json(result.survey);
  } catch (error) {
    fail(res, error);
  }
});

// ---------- 配置化状态动作（保留原通用引擎供“标记异常/完成复查”等使用） ----------

app.post('/api/action/:actionId/:id', async (req, res) => {
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  if (action.endpoint) {
    return res.status(400).json({ error: '该动作需走专用端点', endpoint: action.endpoint });
  }
  try {
    const item = await store.mutate((db) => {
      const target = db[action.collection]?.find((entry) => entry.id === req.params.id);
      if (!target) throw new rules.RuleError('not found', 'not_found');
      return runAction(db, action, target);
    });
    res.json(item);
  } catch (error) {
    if (error.code === 'not_found') return res.status(404).json({ error: 'not found' });
    return fail(res, error);
  }
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function runAction(db, action, item) {
  const related = action.relation ? db[action.relation.collection]?.find((entry) => entry.id === item[action.relation.localKey]) : null;
  const context = { item, related };
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    setValue(target, patch.field, patch.value);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  return item;
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
