const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('./service');
const { can } = require('./permissions');

function fakeDatabase() {
  const collections = new Map();
  const rows = name => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const database = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (!rows(name).has(id)) throw Object.assign(new Error('not found'), { code: 'DOCUMENT_NOT_FOUND' });
              return { data: { ...rows(name).get(id) } };
            },
            async set({ data }) { rows(name).set(id, { _id: id, ...data }); },
            async update({ data }) { rows(name).set(id, { ...rows(name).get(id), ...data }); }
          };
        },
        async get() { return { data: [...rows(name).values()] }; },
        where(filter) {
          return { async get() { return { data: [...rows(name).values()].filter(row => Object.keys(filter).every(key => row[key] === filter[key])) }; } };
        }
      };
    },
    async runTransaction(callback) { return callback(database); }
  };
  return database;
}

test('joining requires administrator approval before workspace access', async () => {
  const service = createService(fakeDatabase(), { adminOpenId: 'admin', now: () => '2026-10-06' });
  await service.session('admin');
  await service.requestJoin('alice', 'Alice');
  assert.equal((await service.session('alice')).status, 'pending');
  await assert.rejects(service.workspace('alice'), { code: 'FORBIDDEN' });
  assert.equal((await service.workspace('admin')).requests.length, 1);
  await assert.rejects(service.review('alice', 'alice', 'approve'), { code: 'FORBIDDEN' });
  await service.review('admin', 'alice', 'approve');
  assert.equal((await service.session('alice')).status, 'approved');
  assert.equal((await service.workspace('alice')).members.length, 2);
  assert.deepEqual((await service.workspace('alice')).requests, []);
});

test('configured administrator is added to an existing office state', async () => {
  const db = fakeDatabase();
  await db.collection('office_state').doc('main').set({ data: { adminOpenId: 'admin', memberIds: [] } });
  const service = createService(db, { adminOpenId: 'admin', now: () => '2026-10-06' });
  assert.equal((await service.session('admin')).member.role, 'admin');
  assert.deepEqual((await db.collection('office_state').doc('main').get()).data.memberIds, ['admin']);
});

test('a forged approved member document cannot enter the workspace', async () => {
  const db = fakeDatabase();
  const service = createService(db, { adminOpenId: 'admin', now: () => '2026-10-06' });
  await service.session('admin');
  await db.collection('members').doc('forged').set({ data: { name: 'Forged', role: 'admin', status: 'approved' } });
  assert.equal((await service.session('forged')).status, 'guest');
  await assert.rejects(service.workspace('forged'), { code: 'FORBIDDEN' });
  await assert.rejects(service.review('forged', 'admin', 'approve'), { code: 'FORBIDDEN' });
  assert.equal((await service.workspace('admin')).members.length, 1);
});

test('rejection preserves denial and permits a new application', async () => {
  const service = createService(fakeDatabase(), { adminOpenId: 'admin', now: () => '2026-10-06' });
  await service.session('admin');
  await service.requestJoin('bob', 'Bob');
  await service.review('admin', 'bob', 'reject');
  assert.equal((await service.session('bob')).status, 'rejected');
  await assert.rejects(service.workspace('bob'), { code: 'FORBIDDEN' });
  await service.requestJoin('bob', 'Bobby');
  assert.equal((await service.session('bob')).request.name, 'Bobby');
});

test('office cannot approve more than five members', async () => {
  const service = createService(fakeDatabase(), { adminOpenId: 'admin', now: () => '2026-10-06' });
  await service.session('admin');
  for (let i = 1; i <= 4; i++) {
    await service.requestJoin(`user${i}`, `User ${i}`);
    await service.review('admin', `user${i}`, 'approve');
  }
  await service.requestJoin('user5', 'User 5');
  await assert.rejects(service.review('admin', 'user5', 'approve'), { code: 'OFFICE_FULL' });
  assert.equal((await service.session('user5')).status, 'pending');
});

test('creator, assignee and confirmer permissions are distinct', () => {
  const member = id => ({ _id: id, status: 'approved', role: 'member' });
  const task = { creatorId: 'creator', assigneeId: 'assignee', confirmerId: 'confirmer', confirmationRule: 'important' };
  assert.equal(can(member('creator'), 'editTask', task), true);
  assert.equal(can(member('assignee'), 'editTask', task), false);
  assert.equal(can(member('assignee'), 'executeTask', task), true);
  assert.equal(can(member('confirmer'), 'confirmTask', task), true);
  assert.equal(can(member('assignee'), 'confirmTask', task), false);
  assert.equal(can({ _id: 'admin', status: 'approved', role: 'admin' }, 'manageMembership'), true);
  assert.equal(can({ _id: 'guest', status: 'pending', role: 'admin' }, 'manageMembership'), false);
});
