const cloud = require('wx-server-sdk');
const { createService, AiError } = require('./service');
const { generate } = require('./provider');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'FORBIDDEN' };
  try {
    const service = createService(cloud.database(), generate, () => new Date().toISOString(), 'deepseek-flash');
    const actions = {
      propose: () => service.propose(openid, event.input),
      cancel: () => service.cancel(openid, event.id),
      confirm: () => service.confirm(openid, event.id, event.suggestions)
    };
    if (!Object.prototype.hasOwnProperty.call(actions, event.action)) throw new AiError('INVALID_ACTION');
    return { ok: true, data: await actions[event.action]() };
  } catch (error) {
    if (error instanceof AiError) return { ok: false, code: error.code };
    console.error('ai_tasks failed', error && error.message);
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
};
