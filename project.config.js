module.exports = {
  port: 3912,
  title: '钟乳石洞穴巡测 · 季末封存与开季复开',
  lede: '围绕洞穴、分区、样点和巡测路线记录微环境数据；季末按样点封存，开季按双人隔时复测评审路线复开，基准修订或撤回巡测会让原结论失效。',
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已封存': 'ok',
    '已复开': 'ok',
    '有效': 'ok',
    '复测合格': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad',
    '待校准': 'warn',
    '不予复开': 'bad',
    '结论失效': 'bad',
    '已撤回': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    sealOrders: { label: '封存单' },
    reopenChecks: { label: '开季复测' },
    reopenOrders: { label: '复开单' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '有效封存单', collection: 'sealOrders', filter: { field: 'status', value: '已封存' } },
    { label: '待校准样点', collection: 'sites', filter: { field: 'calibrationStatus', value: '待校准' } },
    { label: '已复开路线', collection: 'reopenOrders', filter: { field: 'status', value: '已复开' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      focusTitle: '待校准与失效结论',
      focus: [
        { collection: 'sites', field: 'calibrationStatus', values: ['待校准'], limit: 8, view: 'sites', titleFields: ['pointCode', 'route'], title: '待校准样点' },
        { collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 6, view: 'surveys', title: '异常待复查巡测' },
        { collection: 'sealOrders', field: 'status', values: ['结论失效'], limit: 6, view: 'seals', title: '失效封存单' },
        { collection: 'reopenOrders', field: 'status', values: ['不予复开', '结论失效'], limit: 6, view: 'reopens', title: '受阻复开' }
      ]
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      relation: { collection: 'sites', localKey: 'id', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' },
        { label: '基准温度℃', name: 'baselineTemp' },
        { label: '基准湿度%', name: 'baselineHumidity' },
        { label: '基准CO2 ppm', name: 'baselineCo2' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度℃', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度%', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2 ppm', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片',
      searchFields: ['surveyor', 'disturbance', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查', '已撤回'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance', 'reviewNote'],
      detailFields: [
        { label: '温度℃', name: 'temperature' },
        { label: '湿度%', name: 'humidity' },
        { label: 'CO2 ppm', name: 'co2' },
        { label: '滴水频率', name: 'dripRate' }
      ],
      defaults: { status: '正常', reviewNote: '' },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode', 'route'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度℃', name: 'temperature', type: 'number', required: true },
        { label: '湿度%', name: 'humidity', type: 'number', required: true },
        { label: 'CO2 ppm', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'seals',
      label: '季末封存',
      type: 'domain',
      domain: 'seals',
      formTitle: '开具封存单',
      listTitle: '封存单履历',
      submitLabel: '封存',
      searchPlaceholder: '搜索季节、路线、负责人',
      searchFields: ['season', 'route', 'operator'],
      statusField: 'status',
      statusOptions: ['已封存', '结论失效'],
      fields: [
        { label: '封存季节', name: 'season', type: 'season-select', required: true },
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode', 'route'], required: true, wide: true },
        { label: '封存负责人', name: 'operator', required: true },
        { label: '封存日期', name: 'sealedDate', type: 'date' },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ],
      titleFields: ['season', 'route'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      detailFields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['pointCode', 'zone'] },
        { label: '季节', name: 'season' },
        { label: '负责人', name: 'operator' },
        { label: '封存日期', name: 'sealedDate' }
      ]
    },
    {
      id: 'checks',
      label: '开季复测',
      type: 'domain',
      domain: 'checks',
      formTitle: '登记开季复测',
      listTitle: '复测履历（两人各测一次，间隔≥24小时）',
      submitLabel: '提交复测',
      searchPlaceholder: '搜索季节、路线、人员',
      searchFields: ['season', 'route', 'surveyor'],
      statusField: 'status',
      statusOptions: ['有效', '已撤回'],
      fields: [
        { label: '开季季节', name: 'season', type: 'season-select', required: true },
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode', 'route'], required: true, wide: true },
        { label: '复测人员', name: 'surveyor', required: true },
        { label: '测量时间', name: 'measuredAt', type: 'datetime-local' },
        { label: '温度℃', name: 'temperature', type: 'number', required: true },
        { label: '湿度%', name: 'humidity', type: 'number', required: true },
        { label: 'CO2 ppm', name: 'co2', type: 'number', required: true },
        { label: '备注', name: 'note' }
      ],
      titleFields: ['season', 'surveyor'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      detailFields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['pointCode', 'route'] },
        { label: '测量时间', name: 'measuredAt', type: 'datetime' },
        { label: '温度℃', name: 'temperature' },
        { label: '湿度%', name: 'humidity' },
        { label: 'CO2 ppm', name: 'co2' },
        { label: '判定', name: 'verdict' }
      ]
    },
    {
      id: 'reopens',
      label: '路线复开',
      type: 'domain',
      domain: 'reopens',
      formTitle: '开季复开评审',
      listTitle: '复开单履历',
      submitLabel: '提交复开评审',
      searchPlaceholder: '搜索季节、路线、负责人',
      searchFields: ['season', 'route', 'operator'],
      statusField: 'status',
      statusOptions: ['已复开', '不予复开', '结论失效'],
      fields: [
        { label: '开季季节', name: 'season', type: 'season-select', required: true },
        { label: '路线', name: 'route', type: 'route-select', required: true, wide: true },
        { label: '复开负责人', name: 'operator', required: true },
        { label: '复开日期', name: 'reopenedDate', type: 'date' },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ],
      titleFields: ['season', 'route'],
      detailFields: [
        { label: '路线', name: 'route' },
        { label: '季节', name: 'season' },
        { label: '负责人', name: 'operator' },
        { label: '复开日期', name: 'reopenedDate' }
      ]
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] },
    { id: 'site-baseline', label: '修订基准', collection: 'sites', custom: 'baseline' },
    {
      id: 'survey-alert',
      label: '标记异常',
      collection: 'surveys',
      relation: { collection: 'sites', localKey: 'siteId' },
      patches: [
        { field: 'status', value: '异常待复查' },
        { target: 'related', field: 'protectedStatus', value: '重点保护' }
      ]
    },
    { id: 'survey-review', label: '完成复查', collection: 'surveys', patches: [{ field: 'status', value: '已复查' }, { field: 'reviewNote', value: '异常已复核' }] },
    { id: 'survey-withdraw', label: '撤回巡测', collection: 'surveys', danger: true, custom: 'withdrawSurvey' },
    { id: 'check-withdraw', label: '撤回复测', collection: 'reopenChecks', danger: true, custom: 'withdrawCheck' }
  ]
};
