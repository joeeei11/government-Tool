function approved(member) {
  return !!member && member.status === 'approved';
}

function can(member, action, task = {}) {
  if (!approved(member)) return false;
  if (member.role === 'admin') return true;
  if (action === 'viewOffice' || action === 'createTask') return true;
  if (action === 'editTask' || action === 'configureConfirmation') return task.creatorId === member._id;
  if (action === 'executeTask') return task.assigneeId === member._id;
  if (action === 'confirmTask') {
    if (task.confirmationRule === 'major') return true;
    if (task.confirmationRule === 'important') return task.confirmerId === member._id;
    return task.assigneeId === member._id;
  }
  return false;
}

module.exports = { approved, can };
