const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const registerRoutes = require('../routes');

function project(row, fields) {
    if (!fields) return row;
    const included = Object.entries(fields).filter(([key, flag]) => key !== '_id' && flag === 1);
    if (included.length) {
        return Object.fromEntries([
            ...included.map(([key]) => [key, row[key]]),
            ...(fields._id === 0 ? [] : [['_id', row._id]])
        ]);
    }
    return Object.fromEntries(Object.entries(row).filter(([key]) => fields[key] !== 0));
}

function matches(row, where) {
    return Object.entries(where).every(([key, value]) => {
        const actual = row[key] instanceof mongoose.Types.ObjectId ? String(row[key]) : row[key];
        if (value && typeof value === 'object' && '$in' in value) {
            return value.$in.includes(actual);
        }
        return actual === value;
    });
}

function fakeQueries(Model, rows) {
    const original = {
        find: Model.find,
        findById: Model.findById,
        countDocuments: Model.countDocuments
    };
    const calls = [];
    Model.find = where => {
        const state = { where, sort: null, select: null, skip: null, limit: null };
        calls.push({ method: 'find', state });
        return {
            sort(value) { state.sort = value; return this; },
            select(value) { state.select = value; return this; },
            skip(value) { state.skip = value; return this; },
            limit(value) { state.limit = value; return this; },
            then(resolve, reject) {
                let result = rows.filter(row => matches(row, where));
                if (state.sort) {
                    const fields = Object.entries(state.sort);
                    result = [...result].sort((a, b) => {
                        for (const [key, direction] of fields) {
                            const comparison = String(a[key]).localeCompare(String(b[key]));
                            if (comparison) return comparison * direction;
                        }
                        return 0;
                    });
                }
                result = result.slice(state.skip);
                if (state.limit !== null) result = result.slice(0, state.limit);
                return Promise.resolve(result.map(row => project(row, state.select))).then(resolve, reject);
            }
        };
    };
    Model.countDocuments = async where => {
        calls.push({ method: 'countDocuments', where });
        return rows.filter(row => matches(row, where)).length;
    };
    Model.findById = id => {
        const state = { id, select: null };
        calls.push({ method: 'findById', state });
        return {
            select(value) { state.select = value; return this; },
            then(resolve, reject) {
                const row = rows.find(item => String(item._id) === String(id));
                return Promise.resolve(row ? project(row, state.select) : null).then(resolve, reject);
            }
        };
    };
    return {
        calls,
        restore() {
            Model.find = original.find;
            Model.findById = original.findById;
            Model.countDocuments = original.countDocuments;
        }
    };
}

test('GET query parameters on users, tasks, and individual resources', async () => {
    const users = Array.from({ length: 105 }, (_, index) => new User({
        name: `User ${String(index).padStart(3, '0')}`,
        email: `user${index}@example.com`
    }).toObject());
    const tasks = Array.from({ length: 105 }, (_, index) => new Task({
        name: `Task ${String(index).padStart(3, '0')}`,
        deadline: '2026-12-01',
        completed: index % 2 === 0
    }).toObject());
    const userQueries = fakeQueries(User, users);
    const taskQueries = fakeQueries(Task, tasks);
    const app = express();
    app.use(express.json());
    registerRoutes(app, express.Router());
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const path = (resource, params = {}) => `${resource}?${new URLSearchParams(Object.entries(params).map(
        ([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]
    ))}`;
    async function get(target) {
        const response = await fetch(base + target);
        const json = await response.json();
        assert.equal(typeof json.message, 'string');
        assert.ok(Object.hasOwn(json, 'data'));
        return { status: response.status, data: json.data, message: json.message };
    }
    try {
        let result = await get('/users');
        assert.equal(result.status, 200);
        assert.equal(result.data.length, 105, 'users have no default limit');
        result = await get('/tasks');
        assert.equal(result.data.length, 100, 'tasks default to limit 100');
        assert.equal(taskQueries.calls.at(-1).state.limit, 100);
        assert.equal(taskQueries.calls.at(-1).state.skip, 0);

        result = await get(path('/tasks', { where: { completed: true } }));
        assert.equal(result.data.length, 53);
        result = await get(path('/tasks', { where: { _id: { $in: [String(tasks[0]._id), String(tasks[2]._id)] } } }));
        assert.equal(result.data.length, 2);
        result = await get(path('/users', { where: { name: 'Missing' } }));
        assert.deepEqual(result.data, []);
        result = await get(path('/tasks', { where: { name: 'Missing' } }));
        assert.deepEqual(result.data, []);

        result = await get(path('/tasks', { sort: { name: -1 } }));
        assert.equal(result.data[0].name, 'Task 104');
        result = await get(path('/users', { sort: { name: 1 } }));
        assert.equal(result.data[0].name, 'User 000');

        result = await get(path('/users', { select: { name: 1, _id: 0 }, limit: 1 }));
        assert.deepEqual(Object.keys(result.data[0]), ['name']);
        result = await get(path('/tasks', { select: { _id: 0, description: 0 }, limit: 1 }));
        assert.ok(!Object.hasOwn(result.data[0], '_id'));
        assert.ok(!Object.hasOwn(result.data[0], 'description'));

        result = await get(path('/tasks', { skip: 5, limit: 3 }));
        assert.deepEqual(result.data.map(row => row.name), ['Task 005', 'Task 006', 'Task 007']);
        result = await get(path('/tasks', { limit: 0 }));
        assert.deepEqual(result.data, []);

        result = await get(path('/tasks', { count: 'true', where: { completed: true }, skip: 10, limit: 1 }));
        assert.equal(result.data, 53);
        assert.equal(taskQueries.calls.at(-1).method, 'countDocuments');
        assert.deepEqual(taskQueries.calls.at(-1).where, { completed: true });
        result = await get(path('/users', { count: 'true', where: { name: 'Missing' } }));
        assert.equal(result.data, 0);
        result = await get(path('/tasks', {
            where: { completed: true }, sort: { name: -1 }, select: { name: 1 },
            skip: 10, limit: 2, count: 'true'
        }));
        assert.equal(result.data, 53, 'count ignores sorting, selection, skip, and limit');
        result = await get(path('/users', { count: 'false', limit: 2 }));
        assert.equal(result.data.length, 2);

        result = await get(path('/tasks', {
            where: { completed: true }, sort: { name: -1 }, select: { name: 1, _id: 0 },
            skip: 1, limit: 2, count: 'false'
        }));
        assert.deepEqual(result.data, [{ name: 'Task 102' }, { name: 'Task 100' }]);
        result = await get(path('/users', {
            where: { name: 'User 010' }, sort: { name: 1 }, select: { email: 1, _id: 0 },
            skip: 0, limit: 5
        }));
        assert.deepEqual(result.data, [{ email: 'user10@example.com' }]);

        result = await get(path(`/users/${users[0]._id}`, { select: { name: 1, _id: 0 } }));
        assert.deepEqual(result.data, { name: 'User 000' });
        result = await get(path(`/tasks/${tasks[0]._id}`, { select: { completed: 1, _id: 0 } }));
        assert.deepEqual(result.data, { completed: true });
        result = await get(path(`/users/${users[0]._id}`, {
            where: '{bad', sort: '{bad', skip: '-1', limit: '-1', count: 'bad'
        }));
        assert.equal(result.status, 200, 'individual GET ignores every parameter except select');
        assert.equal((await get(`/users/${new mongoose.Types.ObjectId()}`)).status, 404);
        assert.equal((await get('/tasks/bad-id')).status, 404);
        assert.equal((await get(path(`/tasks/${new mongoose.Types.ObjectId()}`, {
            select: { name: 1 }
        }))).status, 404);
        assert.equal((await get(path(`/tasks/${tasks[0]._id}`, {
            where: '{bad', skip: '-1', count: 'bad'
        }))).status, 200);

        for (const [resource, params] of [
            ['/users', { where: '{bad' }],
            ['/tasks', { sort: '{bad' }],
            ['/users', { select: '{bad' }],
            ['/users', { where: [] }],
            ['/tasks', { sort: { name: 0 } }],
            ['/tasks', { sort: { name: '1' } }],
            ['/users', { select: { name: 2 } }],
            ['/users', { select: { name: 1, email: 0 } }],
            ['/users', { skip: '-1' }],
            ['/users', { skip: '1.5' }],
            ['/tasks', { limit: '-1' }],
            ['/tasks', { limit: '1.5' }],
            ['/tasks', { limit: '999999999999999999999' }],
            ['/tasks', { count: '1' }]
        ]) {
            result = await get(path(resource, params));
            assert.equal(result.status, 400, `${resource} ${JSON.stringify(params)}`);
            assert.equal(result.data, null);
        }
        assert.equal((await get(path(`/users/${users[0]._id}`, { select: '{bad' }))).status, 400);
        assert.equal((await get(path(`/tasks/${tasks[0]._id}`, { select: { name: 2 } }))).status, 400);
        assert.equal(users.length, 105);
        assert.equal(tasks.length, 105);

        const normalFind = User.find;
        User.find = () => { throw new mongoose.Error.CastError('ObjectId', 'bad-id', '_id'); };
        result = await get(path('/users', { where: { _id: 'bad-id' } }));
        assert.equal(result.status, 400);
        User.find = normalFind;

        User.find = () => { throw new TypeError('unexpected query failure'); };
        result = await get('/users');
        assert.equal(result.status, 500);
        assert.ok(!result.message.includes('unexpected query failure'));

        User.find = () => { throw new Error('secret database detail'); };
        result = await get('/users');
        assert.equal(result.status, 500);
        assert.ok(!result.message.includes('secret database detail'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        userQueries.restore();
        taskQueries.restore();
    }
});
