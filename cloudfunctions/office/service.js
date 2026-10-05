const { approved, can } = require('./permissions');

class OfficeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function missing(error) {
  return error && (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === -502005 || /not found|does not exist/i.test(error.message || ''));
}

async function read(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data; }
  catch (error) { if (missing(error)) return null; throw error; }
}

function publicMember(member) {
  return { id: member._id, name: member.name, role: member.role };
}

function publicRequest(request) {
  return { id: request._id, name: request.name, status: request.status };
}

function createService(db, options) {
  const { adminOpenId, now } = options;
  if (!adminOpenId) throw new OfficeError('ADMIN_NOT_CONFIGURED');

  async function verifiedMember(database, openid) {
    const state = await read(database, 'office_state', 'main');
    if (!state || !Array.isArray(state.memberIds) || !state.memberIds.includes(openid)) return null;
    const member = await read(database, 'members', openid);
    return approved(member) ? member : null;
  }

  async function ensureAdmin(openid) {
    if (openid !== adminOpenId) return;
    await db.runTransaction(async transaction => {
      const existing = await read(transaction, 'members', openid);
      if (!existing || existing.role !== 'admin' || existing.status !== 'approved') {
        await transaction.collection('members').doc(openid).set({ data: {
          name: existing ? existing.name : '管理员', role: 'admin', status: 'approved', joinedAt: existing ? existing.joinedAt : now()
        } });
      }
      const state = await read(transaction, 'office_state', 'main');
      if (!state) {
        await transaction.collection('office_state').doc('main').set({ data: { adminOpenId: openid, memberIds: [openid] } });
      } else if (!Array.isArray(state.memberIds) || !state.memberIds.includes(openid)) {
        await transaction.collection('office_state').doc('main').update({ data: {
          memberIds: [...(Array.isArray(state.memberIds) ? state.memberIds : []), openid]
        } });
      }
    });
  }

  async function session(openid) {
    await ensureAdmin(openid);
    const member = await verifiedMember(db, openid);
    if (member) return { status: 'approved', member: publicMember(member) };
    const request = await read(db, 'join_requests', openid);
    return { status: request ? request.status : 'guest', request: request ? publicRequest(request) : null };
  }

  async function requestJoin(openid, name) {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (normalized.length < 2 || normalized.length > 20) throw new OfficeError('INVALID_NAME');
    const member = await verifiedMember(db, openid);
    if (member) return { status: 'approved' };
    const existing = await read(db, 'join_requests', openid);
    if (existing && existing.status === 'pending') return { status: 'pending' };
    await db.collection('join_requests').doc(openid).set({ data: {
      name: normalized, status: 'pending', requestedAt: now(), reviewedAt: null, reviewedBy: null
    } });
    return { status: 'pending' };
  }

  async function workspace(openid) {
    const actor = await verifiedMember(db, openid);
    if (!can(actor, 'viewOffice')) throw new OfficeError('FORBIDDEN');
    const state = await read(db, 'office_state', 'main');
    const members = (await db.collection('members').get()).data
      .filter(member => state.memberIds.includes(member._id) && approved(member)).map(publicMember);
    const requests = actor.role === 'admin'
      ? (await db.collection('join_requests').where({ status: 'pending' }).get()).data.map(publicRequest)
      : [];
    return { members, requests };
  }

  async function review(openid, id, decision) {
    if (typeof id !== 'string' || !id || !['approve', 'reject'].includes(decision)) throw new OfficeError('INVALID_ACTION');
    return db.runTransaction(async transaction => {
      const actor = await verifiedMember(transaction, openid);
      if (!can(actor, 'manageMembership')) throw new OfficeError('FORBIDDEN');
      const request = await read(transaction, 'join_requests', id);
      if (!request || request.status !== 'pending') throw new OfficeError('NOT_FOUND');
      const state = await read(transaction, 'office_state', 'main');
      if (!state) throw new OfficeError('NOT_FOUND');
      if (decision === 'approve') {
        if (!Array.isArray(state.memberIds) || state.memberIds.length >= 5) throw new OfficeError('OFFICE_FULL');
        if (state.memberIds.includes(id)) throw new OfficeError('NOT_FOUND');
        await transaction.collection('members').doc(id).set({ data: {
          name: request.name, role: 'member', status: 'approved', joinedAt: now()
        } });
        await transaction.collection('office_state').doc('main').update({ data: { memberIds: [...state.memberIds, id] } });
      }
      await transaction.collection('join_requests').doc(id).update({ data: {
        status: decision === 'approve' ? 'approved' : 'rejected', reviewedAt: now(), reviewedBy: openid
      } });
      return { status: decision === 'approve' ? 'approved' : 'rejected' };
    });
  }

  return { session, requestJoin, workspace, review };
}

module.exports = { createService, OfficeError };
