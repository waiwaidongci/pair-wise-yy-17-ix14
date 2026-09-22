const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

const COLLECTIONS = ['sites', 'surveys', 'sealOrders', 'reopenChecks', 'reopenOrders'];

// 进程内写队列：读-判-写在同一临界区内完成，并发请求按到达顺序串行落库，
// “每样点每季仅一张封存单”的唯一性判断因此不会被交错的 IO 击穿。
let chain = Promise.resolve();

function serialize(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

function normalize(db) {
  for (const key of COLLECTIONS) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return normalize(JSON.parse(raw));
}

async function writeDbAtomic(db) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
  await fs.rename(tmp, DB_FILE);
}

// 在锁内读取最新数据、执行变更并原子落库；mutator 抛错则不写盘。
function mutate(mutator) {
  return serialize(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDbAtomic(db);
    return result;
  });
}

module.exports = { DB_FILE, COLLECTIONS, readDb, mutate, serialize };
