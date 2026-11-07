const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

class ReferenceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function transaction(work) {
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            result = await work(session);
        });
        return result;
    } finally {
        await session.endSession();
    }
}

function uniqueIds(ids) {
    if (new Set(ids.map(id => String(id).toLowerCase())).size !== ids.length) {
        throw new ReferenceError(400, 'Duplicate task reference.');
    }
}

async function tasksForUser(ids, session) {
    uniqueIds(ids);
    const tasks = [];
    for (const id of ids) {
        const task = await Task.findById(id, null, { session });
        if (!task) throw new ReferenceError(404, 'Referenced task not found.');
        tasks.push(task);
    }
    if (tasks.some(task => task.completed)) {
        throw new ReferenceError(400, 'Completed tasks cannot be pending.');
    }
    return tasks;
}

async function unusedEmail(email, excludedId, session) {
    const filter = excludedId
        ? { email, _id: { $ne: excludedId } }
        : { email };
    if (await User.findOne(filter, null, { session })) {
        throw new ReferenceError(400, 'Email is already in use.');
    }
}

async function assignedUser(fields, session) {
    const id = fields.assignedUser || '';
    const suppliedName = fields.assignedUserName;
    if (!id) {
        if (suppliedName !== undefined && suppliedName !== 'unassigned') {
            throw new ReferenceError(400, 'Assigned user name does not match the assigned user.');
        }
        return null;
    }
    const user = await User.findById(id, null, { session });
    if (!user) throw new ReferenceError(404, 'Referenced user not found.');
    if (suppliedName !== undefined && suppliedName !== user.name) {
        throw new ReferenceError(400, 'Assigned user name does not match the assigned user.');
    }
    return user;
}

async function createUser(fields) {
    return transaction(async session => {
        const user = new User(fields);
        await user.validate();
        await unusedEmail(user.email, null, session);
        const tasks = await tasksForUser(user.pendingTasks, session);
        user.pendingTasks = tasks.map(task => String(task._id));
        await user.save({ session });
        const userId = String(user._id);
        for (const task of tasks) {
            const taskId = String(task._id);
            if (task.assignedUser && task.assignedUser !== userId) {
                await User.updateOne(
                    { _id: task.assignedUser },
                    { $pull: { pendingTasks: taskId } },
                    { session }
                );
            }
            await Task.updateOne(
                { _id: task._id },
                { $set: { assignedUser: userId, assignedUserName: user.name } },
                { session }
            );
        }
        return user;
    });
}

async function replaceUser(id, fields) {
    return transaction(async session => {
        const existing = await User.findById(id, null, { session });
        if (!existing) throw new ReferenceError(404, 'User not found.');
        const replacement = new User(fields);
        await replacement.validate();
        await unusedEmail(replacement.email, id, session);
        const tasks = await tasksForUser(replacement.pendingTasks, session);
        replacement.pendingTasks = tasks.map(task => String(task._id));
        const userId = String(id);
        const desiredIds = replacement.pendingTasks.map(String);

        await Task.updateMany(
            { assignedUser: userId, completed: false, _id: { $nin: desiredIds } },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
            { session }
        );
        await Task.updateMany(
            { assignedUser: userId },
            { $set: { assignedUserName: replacement.name } },
            { session }
        );
        for (const task of tasks) {
            const taskId = String(task._id);
            if (task.assignedUser && task.assignedUser !== userId) {
                await User.updateOne(
                    { _id: task.assignedUser },
                    { $pull: { pendingTasks: taskId } },
                    { session }
                );
            }
            await Task.updateOne(
                { _id: task._id },
                { $set: { assignedUser: userId, assignedUserName: replacement.name } },
                { session }
            );
        }

        const values = replacement.toObject({ versionKey: false });
        delete values._id;
        values.dateCreated = existing.dateCreated;
        const updated = await User.findOneAndReplace(
            { _id: id }, values, { returnDocument: 'after', session }
        );
        if (!updated) throw new ReferenceError(404, 'User not found.');
        return updated;
    });
}

async function deleteUser(id) {
    return transaction(async session => {
        const existing = await User.findById(id, null, { session });
        if (!existing) throw new ReferenceError(404, 'User not found.');
        await Task.updateMany(
            { assignedUser: String(id) },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
            { session }
        );
        await User.findByIdAndDelete(id, { session });
    });
}

async function createTask(fields) {
    return transaction(async session => {
        const task = new Task(fields);
        await task.validate();
        const user = await assignedUser(fields, session);
        task.assignedUser = user ? String(user._id) : '';
        task.assignedUserName = user ? user.name : 'unassigned';
        await task.save({ session });
        if (user && !task.completed) {
            await User.updateOne(
                { _id: user._id },
                { $addToSet: { pendingTasks: String(task._id) } },
                { session }
            );
        }
        return task;
    });
}

async function replaceTask(id, fields) {
    return transaction(async session => {
        const existing = await Task.findById(id, null, { session });
        if (!existing) throw new ReferenceError(404, 'Task not found.');
        const replacement = new Task(fields);
        await replacement.validate();
        const user = await assignedUser(fields, session);
        replacement.assignedUser = user ? String(user._id) : '';
        replacement.assignedUserName = user ? user.name : 'unassigned';
        const taskId = String(id);
        if (existing.assignedUser) {
            await User.updateOne(
                { _id: existing.assignedUser },
                { $pull: { pendingTasks: taskId } },
                { session }
            );
        }
        if (user && !replacement.completed) {
            await User.updateOne(
                { _id: user._id },
                { $addToSet: { pendingTasks: taskId } },
                { session }
            );
        }

        const values = replacement.toObject({ versionKey: false });
        delete values._id;
        values.dateCreated = existing.dateCreated;
        const updated = await Task.findOneAndReplace(
            { _id: id }, values, { returnDocument: 'after', session }
        );
        if (!updated) throw new ReferenceError(404, 'Task not found.');
        return updated;
    });
}

async function deleteTask(id) {
    return transaction(async session => {
        const existing = await Task.findById(id, null, { session });
        if (!existing) throw new ReferenceError(404, 'Task not found.');
        if (existing.assignedUser) {
            await User.updateOne(
                { _id: existing.assignedUser },
                { $pull: { pendingTasks: String(id) } },
                { session }
            );
        }
        await Task.findByIdAndDelete(id, { session });
    });
}

module.exports = {
    ReferenceError, createUser, replaceUser, deleteUser,
    createTask, replaceTask, deleteTask
};
