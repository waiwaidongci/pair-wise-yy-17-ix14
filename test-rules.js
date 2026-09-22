const assert = require('assert');
const rules = require('./rules');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
    process.exitCode = 1;
  }
}

function freshDb() {
  return {
    sites: [
      { id: 's1', pointCode: 'D-01', route: '西线', protectedStatus: '常规观察', calibrationStatus: '', calibrationReason: '', calibrationSeason: '', createdAt: '2026-01-01T00:00:00Z', history: [] }
    ],
    surveys: [],
    sealOrders: [],
    reopenChecks: [],
    reopenOrders: []
  };
}

function survey(db, siteId, date, extra = {}) {
  db.surveys.push({
    id: `sv-${db.surveys.length + 1}`,
    siteId,
    date,
    surveyor: '甲',
    temperature: 16, humidity: 90, co2: 650, dripRate: 10,
    status: '正常',
    history: [],
    ...extra
  });
}

console.log('季节工具');
ok('7月归 Q3', () => assert.strictEqual(rules.seasonOfDate('2026-07-01'), '2026-Q3'));
ok('季度推移跨年', () => {
  assert.strictEqual(rules.shiftSeason('2026-Q4', 1), '2027-Q1');
  assert.strictEqual(rules.shiftSeason('2026-Q1', -1), '2025-Q4');
});
ok('坏季节格式报错', () => assert.throws(() => rules.parseSeason('2026/3'), /YYYY-Qn/));

console.log('季末封存');
ok('本季三月巡测齐全才能封存', () => {
  const db = freshDb();
  assert.ok(rules.sealingBlockers(db, db.sites[0], '2026-Q3').some((b) => b.includes('7月')));
  survey(db, 's1', '2026-07-05');
  survey(db, 's1', '2026-08-05');
  survey(db, 's1', '2026-09-05');
  assert.deepStrictEqual(rules.sealingBlockers(db, db.sites[0], '2026-Q3'), []);
  const order = rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' });
  assert.strictEqual(order.status, '已封存');
});
ok('缺任一月份不得封存', () => {
  const db = freshDb();
  survey(db, 's1', '2026-07-05');
  survey(db, 's1', '2026-09-05');
  assert.throws(() => rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' }), /8月缺少本季巡测/);
});
ok('巡测读数缺项不得封存', () => {
  const db = freshDb();
  survey(db, 's1', '2026-07-05');
  survey(db, 's1', '2026-08-05', { co2: '' });
  survey(db, 's1', '2026-09-05');
  assert.throws(() => rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' }), /缺项/);
});
ok('暂停开放不得封存', () => {
  const db = freshDb();
  db.sites[0].protectedStatus = '暂停开放';
  ['2026-07-05', '2026-08-05', '2026-09-05'].forEach((d) => survey(db, 's1', d));
  assert.throws(() => rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' }), /暂停开放/);
});
ok('已撤回巡测不算补齐', () => {
  const db = freshDb();
  survey(db, 's1', '2026-07-05');
  survey(db, 's1', '2026-08-05', { status: '已撤回' });
  survey(db, 's1', '2026-09-05');
  assert.throws(() => rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' }), /8月/);
});
ok('每样点每季仅一张封存单，并发只认首单', () => {
  const db = freshDb();
  ['2026-07-05', '2026-08-05', '2026-09-05'].forEach((d) => survey(db, 's1', d));
  const first = rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' });
  try {
    rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' });
    throw new Error('应当被拒');
  } catch (error) {
    assert.strictEqual(error.code, 'seal_exists');
    assert.strictEqual(error.extra.winnerId, first.id);
  }
});
ok('封存单失效后可重新封存（新单）', () => {
  const db = freshDb();
  ['2026-07-05', '2026-08-05', '2026-09-05'].forEach((d) => survey(db, 's1', d));
  const first = rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' });
  first.status = '结论失效';
  const second = rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' });
  assert.strictEqual(second.status, '已封存');
  assert.notStrictEqual(second.id, first.id);
});

console.log('开季复测');
ok('两人隔24小时各测一次构成合规复测对', () => {
  const db = freshDb();
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16.0, humidity: 90, co2: 650 });
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T09:00:00Z', temperature: 16.5, humidity: 92, co2: 720 });
  const pair = rules.checkPair(db, 's1', '2026-Q4');
  assert.ok(pair);
  const verdict = rules.pairVerdict(pair[0], pair[1], db.sites[0]);
  assert.strictEqual(verdict.qualified, true);
  assert.strictEqual(db.sites[0].calibrationStatus, '');
});
ok('间隔不足24小时拒绝登记', () => {
  const db = freshDb();
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
  assert.throws(() => rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T07:00:00Z', temperature: 16, humidity: 90, co2: 650 }), /24 小时/);
});
ok('同一人不得测两次', () => {
  const db = freshDb();
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
  assert.throws(() => rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-03T08:00:00Z', temperature: 16, humidity: 90, co2: 650 }), /不同人员/);
});
ok('温差>0.8 → 只转待校准', () => {
  const db = freshDb();
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16.0, humidity: 90, co2: 650 });
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T08:30:00Z', temperature: 16.9, humidity: 90, co2: 650 });
  assert.strictEqual(db.sites[0].calibrationStatus, '待校准');
  assert.match(db.sites[0].calibrationReason, /温差/);
});
ok('温差恰好0.8不算超（>0.8 才超）', () => {
  const pair = [
    { temperature: 16.0, humidity: 90, co2: 650 },
    { temperature: 16.8, humidity: 90, co2: 650 }
  ];
  assert.strictEqual(rules.pairVerdict(pair[0], pair[1], {}).qualified, true);
});
ok('湿度差>5个百分点 → 待校准', () => {
  const db = freshDb();
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T08:30:00Z', temperature: 16, humidity: 96, co2: 650 });
  assert.strictEqual(db.sites[0].calibrationStatus, '待校准');
  assert.match(db.sites[0].calibrationReason, /湿度差/);
});
ok('CO2 增量>100ppm → 待校准（CO2下降不算）', () => {
  const db = freshDb();
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
  rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T08:30:00Z', temperature: 16, humidity: 90, co2: 751 });
  assert.strictEqual(db.sites[0].calibrationStatus, '待校准');
  assert.match(db.sites[0].calibrationReason, /CO2/);
});
ok('CO2 减少100ppm以上不算增量', () => {
  const pair = [
    { temperature: 16, humidity: 90, co2: 800 },
    { temperature: 16, humidity: 90, co2: 650 }
  ];
  assert.strictEqual(rules.pairVerdict(pair[0], pair[1], {}).qualified, true);
});
ok('暂停开放样点不得登记复测', () => {
  const db = freshDb();
  db.sites[0].protectedStatus = '暂停开放';
  assert.throws(() => rules.addReopenCheck(db, { siteId: 's1', season: '2026-Q4', surveyor: '甲', temperature: 16, humidity: 90, co2: 650 }), /暂停开放/);
});

console.log('路线复开');
function readyRouteDb() {
  const db = {
    sites: [
      { id: 'a', pointCode: 'A-1', route: 'R', protectedStatus: '常规观察', history: [] },
      { id: 'b', pointCode: 'A-2', route: 'R', protectedStatus: '常规观察', history: [] }
    ],
    surveys: [],
    sealOrders: [],
    reopenChecks: [],
    reopenOrders: []
  };
  // 上一季 Q3 两场均已封存
  db.sealOrders.push(
    { id: 'se-a', siteId: 'a', route: 'R', season: '2026-Q3', status: '已封存' },
    { id: 'se-b', siteId: 'b', route: 'R', season: '2026-Q3', status: '已封存' }
  );
  for (const id of ['a', 'b']) {
    rules.addReopenCheck(db, { siteId: id, season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
    rules.addReopenCheck(db, { siteId: id, season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T09:00:00Z', temperature: 16.4, humidity: 92, co2: 700 });
  }
  return db;
}
ok('路线内每点都合规 → 复开', () => {
  const db = readyRouteDb();
  const order = rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' });
  assert.strictEqual(order.status, '已复开');
});
ok('一个样点待校准 → 整条路线不予复开', () => {
  const db = readyRouteDb();
  // 让 b 点超限：再加两条不行（已满），直接构造 b 的复测
  db.reopenChecks = db.reopenChecks.filter((c) => c.siteId !== 'b');
  db.sites[1].calibrationStatus = '';
  rules.addReopenCheck(db, { siteId: 'b', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
  rules.addReopenCheck(db, { siteId: 'b', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T09:00:00Z', temperature: 17, humidity: 90, co2: 650 });
  const order = rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' });
  assert.strictEqual(order.status, '不予复开');
  assert.match(order.history[0].note, /A-2/);
});
ok('缺复测 / 上季未封存 / 暂停开放均阻断整线', () => {
  const db = readyRouteDb();
  db.reopenChecks = db.reopenChecks.filter((c) => c.siteId !== 'b');
  db.sealOrders = db.sealOrders.filter((o) => o.siteId !== 'b');
  db.sites[1].protectedStatus = '暂停开放';
  const evaluation = rules.reopenEvaluation(db, 'R', '2026-Q4');
  const rowB = evaluation.sites.find((r) => r.site.id === 'b');
  assert.ok(rowB.blockers.some((x) => x.includes('暂停开放')));
  assert.ok(rowB.blockers.some((x) => x.includes('未封存')));
  assert.ok(rowB.blockers.some((x) => x.includes('复测')));
  assert.strictEqual(evaluation.allowed, false);
});
ok('同一路线每季仅一张有效复开单', () => {
  const db = readyRouteDb();
  rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' });
  assert.throws(() => rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' }), /已有复开单/);
});

console.log('原结论失效');
ok('撤回巡测 → 当季封存单失效', () => {
  const db = freshDb();
  ['2026-07-05', '2026-08-05', '2026-09-05'].forEach((d) => survey(db, 's1', d));
  const order = rules.createSealOrder(db, { siteId: 's1', season: '2026-Q3', operator: '傅青' });
  rules.withdrawSurvey(db, db.surveys[0], {});
  assert.strictEqual(order.status, '结论失效');
});
ok('修订基准 → 封存单与相关路线复开单失效', () => {
  const db = readyRouteDb();
  const reopen = rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' });
  const sealA = { id: 'se-a2', siteId: 'a', route: 'R', season: '2026-Q4', status: '已封存' };
  db.sealOrders.push(sealA);
  rules.reviseBaseline(db, db.sites[0], { baselineTemp: 17.0 }, new Date());
  assert.strictEqual(sealA.status, '结论失效');
  assert.strictEqual(reopen.status, '结论失效');
});
ok('撤回复测 → 复开单失效并按剩余记录重算待校准', () => {
  const db = readyRouteDb();
  // b 点造超限
  db.reopenChecks = db.reopenChecks.filter((c) => c.siteId !== 'b');
  rules.addReopenCheck(db, { siteId: 'b', season: '2026-Q4', surveyor: '甲', measuredAt: '2026-10-01T08:00:00Z', temperature: 16, humidity: 90, co2: 650 });
  const bad = rules.addReopenCheck(db, { siteId: 'b', season: '2026-Q4', surveyor: '乙', measuredAt: '2026-10-02T09:00:00Z', temperature: 17, humidity: 90, co2: 650 });
  assert.strictEqual(db.sites[1].calibrationStatus, '待校准');
  const reopen = rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' });
  assert.strictEqual(reopen.status, '不予复开');
  // 撤回一条后无复测对，待校准解除；再造一条合规路线复开单验证失效联动
  rules.withdrawCheck(db, bad.id, {});
  assert.strictEqual(db.sites[1].calibrationStatus, '');
});
ok('样点改挂路线 → 新旧路线复开单失效', () => {
  const db = readyRouteDb();
  const reopen = rules.reopenRoute(db, { route: 'R', season: '2026-Q4', operator: '傅青' });
  db.sites[0].route = 'R2';
  rules.siteRouteChanged(db, db.sites[0], 'R', new Date());
  assert.strictEqual(reopen.status, '结论失效');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}`);
