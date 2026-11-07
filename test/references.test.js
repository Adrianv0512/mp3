const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const registerRoutes = require('../routes');

const copy = value => JSON.parse(JSON.stringify(value));

async function withApi(run) {
    const users = new Map();
    const tasks = new Map();
    const originalSession = mongoose.startSession;
    const originals = new Map();
    let failure = null;

    function fail(model, method) {
        if (failure && failure.model === model && failure.method === method) {
            failure = null;
            throw new Error('injected database failure');
        }
    }
    function snapshot() {
        return {
            users: [...users.entries()].map(([id, row]) => [id, copy(row)]),
            tasks: [...tasks.entries()].map(([id, row]) => [id, copy(row)])
        };
    }
    function restoreSnapshot(state) {
        users.clear();
        tasks.clear();
        for (const [id, row] of state.users) users.set(id, row);
        for (const [id, row] of state.tasks) tasks.set(id, row);
    }
    mongoose.startSession = async () => ({
        withTransaction: async work => {
            const before = snapshot();
            try { return await work(); }
            catch (error) {
                restoreSnapshot(before);
                throw error;
            }
        },
        endSession: async () => {}
    });

    function matches(row, filter) {
        return Object.entries(filter).every(([key, expected]) => {
            if (key === '_id' && expected && expected.$nin) {
                return !expected.$nin.map(String).includes(String(row._id));
            }
            if (key === '_id' && expected && expected.$ne) {
                return String(row._id) !== String(expected.$ne);
            }
            return String(row[key]) === String(expected);
        });
    }
    function applyUpdate(row, update) {
        if (update.$set) Object.assign(row, copy(update.$set));
        if (update.$pull) {
            for (const [key, value] of Object.entries(update.$pull)) {
                row[key] = row[key].filter(item => String(item) !== String(value));
            }
        }
        if (update.$addToSet) {
            for (const [key, value] of Object.entries(update.$addToSet)) {
                if (!row[key].map(String).includes(String(value))) row[key].push(String(value));
            }
        }
    }
    function mock(Model, rows, name) {
        const original = {
            findById: Model.findById, findOne: Model.findOne,
            updateOne: Model.updateOne, updateMany: Model.updateMany,
            findOneAndReplace: Model.findOneAndReplace,
            findByIdAndDelete: Model.findByIdAndDelete,
            save: Model.prototype.save
        };
        originals.set(Model, original);
        Model.findById = async id => copy(rows.get(String(id).toLowerCase()) || null);
        Model.findOne = async filter => copy(
            [...rows.values()].find(row => matches(row, filter)) || null
        );
        Model.prototype.save = async function () {
            fail(name, 'save');
            await this.validate();
            const row = copy(this.toObject());
            if (name === 'User' && [...rows.values()].some(item => item.email === row.email)) {
                throw { code: 11000 };
            }
            rows.set(String(row._id), row);
            return this;
        };
        Model.updateOne = async (filter, update) => {
            fail(name, 'updateOne');
            const row = [...rows.values()].find(item => matches(item, filter));
            if (!row) return { matchedCount: 0 };
            applyUpdate(row, update);
            return { matchedCount: 1 };
        };
        Model.updateMany = async (filter, update) => {
            fail(name, 'updateMany');
            const found = [...rows.values()].filter(row => matches(row, filter));
            found.forEach(row => applyUpdate(row, update));
            return { matchedCount: found.length };
        };
        Model.findOneAndReplace = async (filter, replacement) => {
            fail(name, 'findOneAndReplace');
            const id = String(filter._id);
            if (!rows.has(id)) return null;
            if (name === 'User' && [...rows.entries()].some(
                ([otherId, row]) => otherId !== id && row.email === replacement.email
            )) throw { code: 11000 };
            const row = { ...copy(replacement), _id: id };
            rows.set(id, row);
            return copy(row);
        };
        Model.findByIdAndDelete = async id => {
            fail(name, 'findByIdAndDelete');
            const row = rows.get(String(id)) || null;
            rows.delete(String(id));
            return copy(row);
        };
    }
    mock(User, users, 'User');
    mock(Task, tasks, 'Task');

    const app = express();
    app.use(express.json());
    registerRoutes(app, express.Router());
    const server = app.listen(0, '127.0.0.1');
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
        return { status: response.status, data: json?.data, message: json?.message };
    }
    const state = {
        users, tasks, request, snapshot,
        failNext(model, method) { failure = { model, method }; }
    };
    try {
        await run(state);
    } finally {
        await new Promise(resolve => server.close(resolve));
        mongoose.startSession = originalSession;
        for (const [Model, original] of originals) {
            Model.findById = original.findById;
            Model.findOne = original.findOne;
            Model.updateOne = original.updateOne;
            Model.updateMany = original.updateMany;
            Model.findOneAndReplace = original.findOneAndReplace;
            Model.findByIdAndDelete = original.findByIdAndDelete;
            Model.prototype.save = original.save;
        }
    }
}

const taskBody = (name, extra = {}) => ({ name, deadline: '2026-12-01', ...extra });
const userBody = (name, extra = {}) => ({
    name, email: name.toLowerCase().replaceAll(' ', '') + '@example.com', ...extra
});
const newId = () => String(new mongoose.Types.ObjectId());

test('task assignment, reassignment, completion, reopening, unassignment, and deletion', async () => {
    await withApi(async ({ users, tasks, request }) => {
        const a = (await request('/users', 'POST', userBody('Ada'))).data._id;
        const b = (await request('/users', 'POST', userBody('Bea'))).data._id;
        let result = await request('/tasks', 'POST', taskBody('One', {
            assignedUser: a.toUpperCase()
        }));
        assert.equal(result.status, 201);
        const id = result.data._id;
        const created = result.data.dateCreated;
        assert.equal(result.data.assignedUser, a);
        assert.equal(result.data.assignedUserName, 'Ada');
        assert.deepEqual(users.get(a).pendingTasks, [id]);

        result = await request('/tasks/' + id, 'PUT', taskBody('One', { assignedUser: b }));
        assert.equal(result.status, 200);
        assert.equal(result.data.dateCreated, created);
        assert.equal(result.data.assignedUserName, 'Bea');
        assert.deepEqual(users.get(a).pendingTasks, []);
        assert.deepEqual(users.get(b).pendingTasks, [id]);

        result = await request('/tasks/' + id, 'PUT', taskBody('One', {
            assignedUser: b, completed: true
        }));
        assert.equal(result.status, 200);
        assert.equal(result.data.assignedUser, b);
        assert.deepEqual(users.get(b).pendingTasks, []);

        result = await request('/tasks/' + id, 'PUT', taskBody('One', { assignedUser: b }));
        assert.equal(result.status, 200);
        assert.deepEqual(users.get(b).pendingTasks, [id]);
        result = await request('/tasks/' + id, 'PUT', taskBody('One'));
        assert.equal(result.status, 200);
        assert.equal(result.data.assignedUser, '');
        assert.equal(result.data.assignedUserName, 'unassigned');
        assert.deepEqual(users.get(b).pendingTasks, []);

        result = await request('/tasks/' + id, 'PUT', taskBody('One', { assignedUser: a }));
        assert.equal(result.status, 200);
        assert.deepEqual(users.get(a).pendingTasks, [id]);
        assert.equal((await request('/tasks/' + id, 'DELETE')).status, 204);
        assert.equal(tasks.has(id), false);
        assert.deepEqual(users.get(a).pendingTasks, []);

        result = await request('/tasks', 'POST', taskBody('Done', {
            assignedUser: b, completed: true
        }));
        const doneId = result.data._id;
        assert.deepEqual(users.get(b).pendingTasks, []);
        result = await request('/tasks/' + doneId, 'PUT', taskBody('Done', {
            assignedUser: a, completed: true
        }));
        assert.equal(result.status, 200);
        assert.equal(result.data.assignedUserName, 'Ada');
        assert.deepEqual(users.get(a).pendingTasks, []);
    });
});

test('user creation, moving tasks, replacement, renaming, and deletion', async () => {
    await withApi(async ({ users, tasks, request }) => {
        const t1 = (await request('/tasks', 'POST', taskBody('One'))).data._id;
        const t2 = (await request('/tasks', 'POST', taskBody('Two'))).data._id;
        const t3 = (await request('/tasks', 'POST', taskBody('Three'))).data._id;
        let result = await request('/users', 'POST', userBody('Ada', {
            pendingTasks: [t1.toUpperCase(), t2]
        }));
        assert.equal(result.status, 201);
        const a = result.data._id;
        const created = result.data.dateCreated;
        assert.deepEqual(result.data.pendingTasks, [t1, t2]);
        assert.equal(tasks.get(t1).assignedUserName, 'Ada');
        assert.equal(tasks.get(t2).assignedUser, a);
        const b = (await request('/users', 'POST', userBody('Bea', {
            pendingTasks: [t2]
        }))).data._id;
        assert.deepEqual(users.get(a).pendingTasks, [t1]);
        assert.deepEqual(users.get(b).pendingTasks, [t2]);
        assert.equal(tasks.get(t2).assignedUserName, 'Bea');

        const done = (await request('/tasks', 'POST', taskBody('Done', {
            assignedUser: a, completed: true
        }))).data._id;
        result = await request('/users/' + a, 'PUT', userBody('Ada New', {
            email: 'ada@example.com', pendingTasks: [t1, t3],
            dateCreated: '1999-01-01'
        }));
        assert.equal(result.status, 200);
        assert.equal(result.data.dateCreated, created);
        assert.deepEqual(result.data.pendingTasks, [t1, t3]);
        assert.equal(tasks.get(t1).assignedUserName, 'Ada New');
        assert.equal(tasks.get(t3).assignedUser, a);
        assert.equal(tasks.get(done).assignedUserName, 'Ada New');

        result = await request('/users/' + a, 'PUT', userBody('Ada New', {
            email: 'ada@example.com', pendingTasks: [t3]
        }));
        assert.equal(result.status, 200);
        assert.equal(tasks.get(t1).assignedUser, '');
        assert.equal(tasks.get(t1).assignedUserName, 'unassigned');
        result = await request('/users/' + a, 'PUT', userBody('Ada New', {
            email: 'ada@example.com', pendingTasks: [t2, t3]
        }));
        assert.equal(result.status, 200);
        assert.deepEqual(users.get(b).pendingTasks, []);
        assert.equal(tasks.get(t2).assignedUser, a);

        assert.equal((await request('/users/' + a, 'DELETE')).status, 204);
        assert.equal(users.has(a), false);
        for (const id of [t2, t3, done]) {
            assert.equal(tasks.get(id).assignedUser, '');
            assert.equal(tasks.get(id).assignedUserName, 'unassigned');
        }
        assert.equal(users.has(b), true);
    });
});

test('invalid references and conflicting names leave both collections unchanged', async () => {
    await withApi(async ({ users, tasks, request, snapshot }) => {
        const a = (await request('/users', 'POST', userBody('Ada'))).data._id;
        const b = (await request('/users', 'POST', userBody('Bea'))).data._id;
        const pending = (await request('/tasks', 'POST', taskBody('Pending'))).data._id;
        const done = (await request('/tasks', 'POST', taskBody('Done', {
            completed: true
        }))).data._id;
        const before = snapshot();
        for (const [path, method, body, status] of [
            ['/users', 'POST', userBody('Bad', { pendingTasks: ['bad-id'] }), 400],
            ['/users', 'POST', userBody('Bad', { pendingTasks: [newId()] }), 404],
            ['/users', 'POST', userBody('Bad', { pendingTasks: [pending, pending] }), 400],
            ['/users', 'POST', userBody('Bad', {
                pendingTasks: [pending, pending.toUpperCase()]
            }), 400],
            ['/users', 'POST', userBody('Bad', { pendingTasks: [done] }), 400],
            ['/tasks', 'POST', taskBody('Bad', { assignedUser: 'bad-id' }), 400],
            ['/tasks', 'POST', taskBody('Bad', { assignedUser: newId() }), 404],
            ['/tasks', 'POST', taskBody('Bad', {
                assignedUser: a, assignedUserName: 'Bea'
            }), 400],
            ['/tasks', 'POST', taskBody('Bad', { assignedUserName: 'Ada' }), 400],
            ['/users/bad-id', 'PUT', { name: 5 }, 404],
            ['/tasks/bad-id', 'PUT', { name: 5 }, 404],
            ['/users/' + a, 'PUT', userBody('Bad', {
                email: 'bea@example.com', pendingTasks: [newId()]
            }), 400],
            ['/users/' + a, 'PUT', userBody('Bad', {
                email: 'ada@example.com', pendingTasks: [newId()]
            }), 404],
            ['/users/' + a, 'PUT', userBody('Bad', {
                email: 'ada@example.com', pendingTasks: [done]
            }), 400],
            ['/tasks/' + pending, 'PUT', taskBody('Bad', {
                assignedUser: newId()
            }), 404],
            ['/tasks/' + pending, 'PUT', taskBody('Bad', {
                assignedUser: b, assignedUserName: 'Ada'
            }), 400]
        ]) {
            const result = await request(path, method, body);
            assert.equal(result.status, status, path + ' ' + JSON.stringify(body));
            assert.deepEqual(snapshot(), before);
        }
        assert.equal(users.size, 2);
        assert.equal(tasks.size, 2);
    });
});

test('transactions roll back changes after a later write fails', async () => {
    await withApi(async ({ request, snapshot, failNext }) => {
        const a = (await request('/users', 'POST', userBody('Ada'))).data._id;
        const task = (await request('/tasks', 'POST', taskBody('One'))).data._id;
        let before = snapshot();
        failNext('Task', 'updateOne');
        let result = await request('/users', 'POST', userBody('Bea', {
            pendingTasks: [task]
        }));
        assert.equal(result.status, 500);
        assert.ok(!result.message.includes('injected'));
        assert.deepEqual(snapshot(), before);

        before = snapshot();
        failNext('User', 'updateOne');
        result = await request('/tasks', 'POST', taskBody('Two', { assignedUser: a }));
        assert.equal(result.status, 500);
        assert.deepEqual(snapshot(), before);

        before = snapshot();
        failNext('User', 'findOneAndReplace');
        result = await request('/users/' + a, 'PUT', userBody('Ada New', {
            email: 'ada@example.com', pendingTasks: [task]
        }));
        assert.equal(result.status, 500);
        assert.deepEqual(snapshot(), before);

        const assigned = (await request('/tasks', 'POST', taskBody('Assigned', {
            assignedUser: a
        }))).data._id;
        before = snapshot();
        failNext('Task', 'findOneAndReplace');
        result = await request('/tasks/' + assigned, 'PUT', taskBody('Assigned', {
            completed: true, assignedUser: a
        }));
        assert.equal(result.status, 500);
        assert.deepEqual(snapshot(), before);

        failNext('User', 'findByIdAndDelete');
        result = await request('/users/' + a, 'DELETE');
        assert.equal(result.status, 500);
        assert.deepEqual(snapshot(), before);

        failNext('Task', 'findByIdAndDelete');
        result = await request('/tasks/' + assigned, 'DELETE');
        assert.equal(result.status, 500);
        assert.deepEqual(snapshot(), before);
    });
});
