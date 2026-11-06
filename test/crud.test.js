const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const registerRoutes = require('../routes');

function fakeDatabase(Model, uniqueEmail = false) {
    const records = new Map();
    const original = {
        find: Model.find, findById: Model.findById,
        findOneAndReplace: Model.findOneAndReplace,
        findByIdAndDelete: Model.findByIdAndDelete, save: Model.prototype.save
    };
    Model.find = async () => [...records.values()];
    Model.findById = async id => records.get(String(id)) || null;
    Model.prototype.save = async function () {
        await this.validate();
        const value = this.toObject();
        if (uniqueEmail && [...records.values()].some(row => row.email === value.email)) {
            throw { code: 11000 };
        }
        records.set(String(value._id), value);
        return this;
    };
    Model.findOneAndReplace = async (filter, value) => {
        const id = String(filter._id);
        if (!records.has(id)) return null;
        if (uniqueEmail && [...records.entries()].some(
            ([key, row]) => key !== id && row.email === value.email
        )) throw { code: 11000 };
        const row = { ...value, _id: new mongoose.Types.ObjectId(id) };
        records.set(id, row);
        return row;
    };
    Model.findByIdAndDelete = async id => {
        const row = records.get(String(id)) || null;
        records.delete(String(id));
        return row;
    };
    return {
        records,
        restore() {
            Model.find = original.find;
            Model.findById = original.findById;
            Model.findOneAndReplace = original.findOneAndReplace;
            Model.findByIdAndDelete = original.findByIdAndDelete;
            Model.prototype.save = original.save;
        }
    };
}

test('all CRUD endpoints: success, validation, replacement, and no changes on failure', async () => {
    const users = fakeDatabase(User, true);
    const tasks = fakeDatabase(Task);
    const app = express();
    app.use(express.json());
    registerRoutes(app, express.Router());
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    async function request(path, method = 'GET', body) {
        const response = await fetch(base + path, {
            method,
            headers: body === undefined ? {} : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        const json = text ? JSON.parse(text) : null;
        if (response.status === 204) assert.equal(text, '');
        else {
            assert.equal(typeof json.message, 'string');
            assert.ok(Object.hasOwn(json, 'data'));
        }
        return { status: response.status, json };
    }
    const newId = () => String(new mongoose.Types.ObjectId());
    try {
        let result = await request('/users');
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.data, []);
        result = await request('/users', 'POST', {
            name: 'Ada', email: 'ada@example.com', dateCreated: '2000-01-01'
        });
        assert.equal(result.status, 201);
        const userId = result.json.data._id;
        const userCreated = result.json.data.dateCreated;
        assert.deepEqual(result.json.data.pendingTasks, []);
        assert.notEqual(userCreated, '2000-01-01T00:00:00.000Z');
        assert.equal((await request('/users/' + userId)).status, 200);
        assert.equal((await request('/users/bad-id')).status, 404);
        assert.equal((await request('/users/' + newId())).status, 404);
        assert.equal((await request('/users', 'POST', { name: '', email: 'wrong' })).status, 400);
        assert.equal((await request('/users', 'POST', { name: 'Other', email: 'ada@example.com' })).status, 400);
        assert.equal((await request('/users', 'POST', { name: 5, email: 'a@b.com' })).status, 400);
        assert.equal(users.records.size, 1);
        result = await request('/users/' + userId, 'PUT', {
            name: 'Ada Lovelace', email: 'ada@example.com', dateCreated: '1999-01-01'
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.dateCreated, userCreated);
        assert.deepEqual(result.json.data.pendingTasks, []);
        result = await request('/users/' + userId, 'PUT', {
            name: 'Ada Lovelace', email: 'ada@example.com', pendingTasks: [newId()]
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.pendingTasks.length, 1);
        result = await request('/users/' + userId, 'PUT', {
            name: 'Ada Lovelace', email: 'ada@example.com'
        });
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.data.pendingTasks, []);
        assert.equal(result.json.data.dateCreated, userCreated);
        assert.equal((await request('/users/' + userId, 'PUT', { name: 'Only name' })).status, 400);
        assert.equal((await request('/users/' + userId, 'PUT', {
            name: 'A', email: 'a@b.com', pendingTasks: 'bad'
        })).status, 400);
        assert.equal((await request('/users/bad-id', 'PUT', {
            name: 'A', email: 'a@b.com'
        })).status, 404);
        assert.equal((await request('/users/' + userId)).json.data.name, 'Ada Lovelace');

        result = await request('/tasks');
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.data, []);
        result = await request('/tasks', 'POST', {
            name: 'Write notes', deadline: '2026-12-01T00:00:00.000Z'
        });
        assert.equal(result.status, 201);
        const taskId = result.json.data._id;
        const taskCreated = result.json.data.dateCreated;
        assert.equal(result.json.data.assignedUser, '');
        assert.equal(result.json.data.assignedUserName, 'unassigned');
        assert.equal(result.json.data.description, '');
        assert.equal(result.json.data.completed, false);
        assert.equal((await request('/tasks/' + taskId)).status, 200);
        assert.equal((await request('/tasks/bad-id')).status, 404);
        assert.equal((await request('/tasks/' + newId())).status, 404);
        assert.equal((await request('/tasks', 'POST', { name: 'Bad' })).status, 400);
        assert.equal((await request('/tasks', 'POST', {
            name: 'Bad', deadline: 'not-a-date'
        })).status, 400);
        assert.equal((await request('/tasks', 'POST', {
            name: 'Bad', deadline: '2026-12-01', completed: 'false'
        })).status, 400);
        assert.equal(tasks.records.size, 1);
        result = await request('/tasks/' + taskId, 'PUT', {
            name: 'Revised notes', deadline: '2026-12-02T00:00:00.000Z',
            completed: true, description: 'Draft', dateCreated: '1999-01-01'
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.dateCreated, taskCreated);
        result = await request('/tasks/' + taskId, 'PUT', {
            name: 'Final notes', deadline: '2026-12-03T00:00:00.000Z'
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.description, '');
        assert.equal(result.json.data.completed, false);
        assert.equal(result.json.data.dateCreated, taskCreated);
        assert.equal((await request('/tasks/' + taskId, 'PUT', {
            name: 'Only name'
        })).status, 400);
        assert.equal((await request('/tasks/' + taskId, 'PUT', {
            name: 'Bad', deadline: 123
        })).status, 400);
        assert.equal((await request('/tasks/bad-id', 'PUT', {
            name: 'Bad', deadline: '2026-12-01'
        })).status, 404);
        assert.equal((await request('/tasks/' + taskId)).json.data.name, 'Final notes');
        assert.equal((await request('/tasks/bad-id', 'DELETE')).status, 404);
        assert.equal((await request('/tasks/' + taskId, 'DELETE')).status, 204);
        assert.equal((await request('/tasks/' + taskId)).status, 404);
        assert.equal((await request('/users/bad-id', 'DELETE')).status, 404);
        assert.equal((await request('/users/' + userId, 'DELETE')).status, 204);
        assert.equal((await request('/users/' + userId)).status, 404);
        const invalidJson = await fetch(base + '/users', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad'
        });
        assert.equal(invalidJson.status, 400);
        assert.deepEqual(Object.keys(await invalidJson.json()).sort(), ['data', 'message']);
        User.find = async () => { throw new Error('database internals'); };
        result = await request('/users');
        assert.equal(result.status, 500);
        assert.equal(result.json.data, null);
        assert.ok(!result.json.message.includes('database internals'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        users.restore();
        tasks.restore();
    }
});

test('PUT keeps dateCreated through the real Mongoose replacement query', async () => {
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    const userId = String(new mongoose.Types.ObjectId());
    const taskId = String(new mongoose.Types.ObjectId());
    const original = {
        userFind: User.findById,
        taskFind: Task.findById,
        userReplace: User.collection.findOneAndReplace,
        taskReplace: Task.collection.findOneAndReplace
    };
    const observed = [];
    User.findById = async () => ({ dateCreated: oldDate });
    Task.findById = async () => ({ dateCreated: oldDate });
    User.collection.findOneAndReplace = async (filter, replacement) => {
        observed.push(replacement.dateCreated.toISOString());
        return { _id: filter._id, ...replacement };
    };
    Task.collection.findOneAndReplace = async (filter, replacement) => {
        observed.push(replacement.dateCreated.toISOString());
        return { _id: filter._id, ...replacement };
    };
    const app = express();
    app.use(express.json());
    registerRoutes(app, express.Router());
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    try {
        for (const [path, body] of [
            ['/users/' + userId, { name: 'Ada', email: 'ada@example.com' }],
            ['/tasks/' + taskId, { name: 'Notes', deadline: '2026-12-01' }]
        ]) {
            const response = await fetch(base + path, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            assert.equal(response.status, 200);
            const json = await response.json();
            assert.equal(json.data.dateCreated, oldDate.toISOString());
        }
        assert.deepEqual(observed, [oldDate.toISOString(), oldDate.toISOString()]);
    } finally {
        await new Promise(resolve => server.close(resolve));
        User.findById = original.userFind;
        Task.findById = original.taskFind;
        User.collection.findOneAndReplace = original.userReplace;
        Task.collection.findOneAndReplace = original.taskReplace;
    }
});
