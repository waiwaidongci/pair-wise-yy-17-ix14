# 钟乳石洞穴季末封存与开季复开

在微环境巡测闭环之上扩展的季节管理平台。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3912

数据保存在`data/db.json`，后续可以继续增量迭代。

## 平台规则

- 每样点每季仅一张封存单，并发只认首单（所有写请求串行处理）。
- 封存须补齐本季巡测；样点暂停开放或本季巡测缺项（温度/湿度/CO2/滴水频率）不得封存。
- 开季前路线内每点须两名不同人员各测一次、间隔≥24小时；温差>0.8℃、湿度差>5个百分点或CO2增量>100ppm 只转待校准，整条路线不得复开；再次出现合格复测对后校准闭环。
- 修订基准或撤回巡测，原封存结论即失效。

## 代码分层

- 规则：`rules.js`（季节、阈值、封存门槛、复测对、失效联动，纯函数）
- 存储：`server.js` + `data/db.json`（通用 CRUD + 季节接口，写请求串行化）
- 页面：`public/`（配置驱动渲染，季节视图数据全部来自 `/api/season/overview`，路线、待校准清单与履历同源一致）

## 季节接口

- `GET /api/season/overview` 路线/封存/复测/待校准/履历总览
- `POST /api/season/seal` `{ siteId, note }`
- `POST /api/season/recheck` `{ siteId, surveyor, measuredAt, temperature, humidity, co2, note }`
- `POST /api/season/reopen` `{ route }`
- `POST /api/season/withdraw-survey/:id` `{ note? }`
- `POST /api/season/revise-baseline` `{ siteId, baselineTemp, baselineHumidity, baselineCo2, note }`
