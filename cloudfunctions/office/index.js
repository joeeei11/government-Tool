const cloud = require('wx-server-sdk');
const { createService, OfficeError } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'FORBIDDEN' };
  if (event.action === 'identity') return { ok: true, data: { openid } };
  try {
    const db = cloud.database();
    let config;
    try { config = (await db.collection('office_state').doc('main').get()).data; }
    catch (error) {
      if (error.code !== 'DOCUMENT_NOT_FOUND' && error.errCode !== -502005) throw error;
    }
    const service = createService(db, {
      adminOpenId: config && config.adminOpenId,
      now: () => new Date().toISOString()
    });
    const actions = {
      session: () => service.session(openid),
      requestJoin: () => service.requestJoin(openid, event.name),
      workspace: () => service.workspace(openid),
      review: () => service.review(openid, event.id, event.decision)
    };
    if (!Object.prototype.hasOwnProperty.call(actions, event.action)) throw new OfficeError('INVALID_ACTION');
    return { ok: true, data: await actions[event.action]() };
  } catch (error) {
    if (error instanceof OfficeError) return { ok: false, code: error.code };
    console.error('office function failed', error);
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
};
