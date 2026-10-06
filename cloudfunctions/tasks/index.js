const cloud = require('wx-server-sdk');
const { createService, TaskError } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'FORBIDDEN' };
  try {
    const service = createService(cloud.database(), () => new Date().toISOString());
    const actions = {
      list: () => service.list(openid),
      workbox: () => service.listWorkbox(openid),
      get: () => service.get(openid, event.id),
      create: () => service.create(openid, event.task),
      update: () => service.update(openid, event.id, event.task)
      ,deleteDraft: () => service.deleteDraft(openid, event.id)
    };
    if (!Object.prototype.hasOwnProperty.call(actions, event.action)) throw new TaskError('INVALID_ACTION');
    return { ok: true, data: await actions[event.action]() };
  } catch (error) {
    if (error instanceof TaskError) return { ok: false, code: error.code };
    console.error('tasks function failed', error);
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
};
