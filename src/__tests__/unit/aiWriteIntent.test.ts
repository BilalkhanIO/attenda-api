import { explicitlyRequestedWrite } from '../../services/ai/write-intent';

describe('AI write intent gate', () => {
  it('does not treat questions or negated requests as authorization, even for permissive project tools', () => {
    expect(explicitlyRequestedWrite('createProject', { name: 'New office' }, 'Can you create a project?')).toBe(false);
    expect(explicitlyRequestedWrite('createProject', { name: 'New office' }, "Don't create a project yet")).toBe(false);
    expect(explicitlyRequestedWrite('updateProjectDetails', { priority: 'high' }, 'Could you change its priority?')).toBe(false);
    expect(explicitlyRequestedWrite('manageProjectMember', { action: 'remove' }, "Do not remove Marcus from the project")).toBe(false);
    expect(explicitlyRequestedWrite('addProjectTaskComment', { body: 'Update' }, 'Should I add a comment?')).toBe(false);
    expect(explicitlyRequestedWrite('requestLeave', { type: 'annual' }, 'How do I request leave?')).toBe(false);
  });

  it('accepts direct latest-turn commands for supported writes', () => {
    expect(explicitlyRequestedWrite('createProject', { name: 'New office' }, 'Create a project called New office')).toBe(true);
    expect(explicitlyRequestedWrite('updateProjectDetails', { priority: 'high' }, 'Set the project priority to high')).toBe(true);
    expect(explicitlyRequestedWrite('manageProjectMember', { action: 'add' }, 'Add Marcus to the project')).toBe(true);
    expect(explicitlyRequestedWrite('addProjectTaskComment', { body: 'Please review' }, 'Add this comment to the task: Please review')).toBe(true);
    expect(explicitlyRequestedWrite('requestLeave', { type: 'annual' }, 'Please submit a leave request for next Monday')).toBe(true);
  });

  it('requires each changed task field to match explicit user intent', () => {
    expect(explicitlyRequestedWrite('updateProjectTask', { taskId: 'task-1', assigneeId: 'user-2' }, 'Assign the task to Marcus')).toBe(true);
    expect(explicitlyRequestedWrite('updateProjectTask', { taskId: 'task-1', dueDate: '2026-11-10', assigneeId: 'user-2' }, 'Move the due date to November 10')).toBe(false);
    expect(explicitlyRequestedWrite('updateProjectTaskStatus', { status: 'done' }, 'What tasks are done?')).toBe(false);
  });
});
