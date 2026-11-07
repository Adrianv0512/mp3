const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const registerRoutes = require('../routes');

require('dotenv').config({ quiet: true });

test('CRUD, queries, references, and failed writes on a temporary Atlas database', {
    skip: process.env.RUN_ATLAS_TESTS !== '1'
}, async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri || /<[^>]+>/.test(uri)) {
        throw new Error('Set a real MONGODB_URI in the ignored .env file before running Atlas tests.');
    }

    const databaseName = 'apied_it_' + new mongoose.Types.ObjectId().toString();
    let server;
    try {
        await mongoose.connect(uri, {
            dbName: databaseName,
            serverSelectionTimeoutMS: 10000
        });
        await Promise.all([User.init(), Task.init()]);
        const app = express();
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());
        registerRoutes(app, express.Router());
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = 'http://127.0.0.1:' + server.address().port + '/api';
        const absentId = () => String(new mongoose.Types.ObjectId());
        const taskBody = (name, extra = {}) => ({
            name, deadline: '2026-12-01T00:00:00.000Z', ...extra
        });

        async function request(path, method = 'GET', body) {
            const response = await fetch(base + path, {
                method,
                headers: body === undefined ? {} : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const raw = await response.text();
            if (response.status === 204) {
                assert.equal(raw, '');
                return { status: response.status };
            }
            const json = JSON.parse(raw);
            assert.equal(typeof json.message, 'string');
            assert.ok(Object.hasOwn(json, 'data'));
            return { status: response.status, data: json.data, message: json.message };
        }

        async function snapshot() {
            return JSON.stringify({
                users: await User.find().sort({ _id: 1 }).lean(),
                tasks: await Task.find().sort({ _id: 1 }).lean()
            });
        }

        async function unchanged(path, method, body, status) {
            const before = await snapshot();
            const result = await request(path, method, body);
            assert.equal(result.status, status, method + ' ' + path);
            assert.equal(await snapshot(), before, 'failed request changed the database');
        }

        let result = await request('/users', 'POST', {
            name: 'Ada', email: 'internal-id', dateCreated: '1999-01-01'
        });
        assert.equal(result.status, 201);
        const ada = result.data._id;
        const adaCreated = result.data.dateCreated;
        assert.deepEqual(result.data.pendingTasks, []);
        assert.notEqual(adaCreated, '1999-01-01T00:00:00.000Z');
        result = await request('/users', 'POST', { name: 'Bea', email: 'bea@example.com' });
        assert.equal(result.status, 201);
        const bea = result.data._id;

        result = await request('/tasks', 'POST', taskBody('Alpha', { assignedUser: ada }));
        assert.equal(result.status, 201);
        const alpha = result.data._id;
        const alphaCreated = result.data.dateCreated;
        assert.equal(result.data.assignedUserName, 'Ada');
        assert.deepEqual((await request('/users/' + ada)).data.pendingTasks, [alpha]);
        result = await request('/tasks', 'POST', taskBody('Beta'));
        assert.equal(result.status, 201);
        const beta = result.data._id;
        assert.equal(result.data.assignedUser, '');
        assert.equal(result.data.assignedUserName, 'unassigned');
        assert.equal(result.data.completed, false);
        assert.equal(result.data.description, '');
        result = await request('/tasks', 'POST', taskBody('Done', {
            assignedUser: bea, completed: true
        }));
        assert.equal(result.status, 201);
        const done = result.data._id;
        assert.deepEqual((await request('/users/' + bea)).data.pendingTasks, []);

        assert.equal((await request('/users')).data.length, 2);
        assert.equal((await request('/tasks')).data.length, 3);
        assert.equal((await request('/users/' + ada)).status, 200);
        assert.equal((await request('/tasks/' + alpha)).status, 200);
        assert.deepEqual((await request('/users/' + ada + '?select=' +
            encodeURIComponent(JSON.stringify({ name: 1, _id: 0 })))).data, { name: 'Ada' });
        assert.deepEqual((await request('/tasks/' + alpha + '?select=' +
            encodeURIComponent(JSON.stringify({ completed: 1, _id: 0 })))).data, {
            completed: false
        });

        const query = new URLSearchParams({
            where: JSON.stringify({ completed: false }),
            sort: JSON.stringify({ name: -1 }),
            select: JSON.stringify({ name: 1, _id: 0 }),
            skip: '0',
            limit: '1',
            count: 'false'
        });
        assert.deepEqual((await request('/tasks?' + query)).data, [{ name: 'Beta' }]);
        assert.equal((await request('/tasks?where=' +
            encodeURIComponent(JSON.stringify({ completed: false })) + '&count=true')).data, 2);
        assert.equal((await request('/tasks?count=true')).data, 3);
        assert.deepEqual((await request('/tasks?sort=' +
            encodeURIComponent(JSON.stringify({ name: 1 })))).data.map(row => row.name),
            ['Alpha', 'Beta', 'Done']);
        assert.deepEqual((await request('/tasks?sort=' +
            encodeURIComponent(JSON.stringify({ name: 1 })) + '&skip=1')).data
            .map(row => row.name), ['Beta', 'Done']);
        assert.equal((await request('/tasks?limit=1')).data.length, 1);
        assert.deepEqual((await request('/users?select=' +
            encodeURIComponent(JSON.stringify({ name: 1, _id: 0 })))).data
            .map(row => row.name).sort(), ['Ada', 'Bea']);
        assert.deepEqual((await request('/users?where=' +
            encodeURIComponent(JSON.stringify({ name: 'Nobody' })))).data, []);
        assert.equal((await request('/users?where=' +
            encodeURIComponent(JSON.stringify({ name: 'Nobody' })) + '&count=true')).data, 0);
        assert.equal((await request('/tasks?where=%7Bbad')).status, 400);
        assert.equal((await request('/tasks?sort=%7Bbad')).status, 400);
        assert.equal((await request('/tasks?select=%7Bbad')).status, 400);
        assert.equal((await request('/users?skip=-1')).status, 400);
        assert.equal((await request('/tasks?limit=-1')).status, 400);
        assert.equal((await request('/tasks?count=1')).status, 400);
        assert.equal((await request('/tasks/' + alpha + '?select=%7Bbad')).status, 400);

        await unchanged('/users', 'POST', { name: 'Duplicate', email: 'internal-id' }, 400);
        await unchanged('/users', 'POST', { name: '', email: 'new-id' }, 400);
        await unchanged('/tasks', 'POST', { name: 'Missing deadline' }, 400);
        await unchanged('/tasks', 'POST', taskBody('Bad user', {
            assignedUser: 'bad-id'
        }), 400);
        await unchanged('/tasks', 'POST', taskBody('Unknown user', {
            assignedUser: absentId()
        }), 404);
        await unchanged('/tasks', 'POST', taskBody('Wrong name', {
            assignedUser: ada, assignedUserName: 'Bea'
        }), 400);
        await unchanged('/users', 'POST', {
            name: 'Bad', email: 'bad-id', pendingTasks: ['bad-id']
        }, 400);
        await unchanged('/users', 'POST', {
            name: 'Bad', email: 'bad-id', pendingTasks: [absentId()]
        }, 404);
        await unchanged('/users', 'POST', {
            name: 'Bad', email: 'bad-id', pendingTasks: [done]
        }, 400);
        await unchanged('/users/' + absentId(), 'PUT', { name: 3 }, 404);
        await unchanged('/tasks/' + absentId(), 'PUT', { name: 3 }, 404);
        await unchanged('/users/' + ada, 'PUT', {
            name: 'Ada', email: 'internal-id', pendingTasks: [absentId()]
        }, 404);
        await unchanged('/users/' + ada, 'PUT', {
            name: 'Ada', email: 'bea@example.com'
        }, 400);
        await unchanged('/users/' + ada, 'PUT', {
            name: 'Ada'
        }, 400);
        await unchanged('/users/' + ada, 'PUT', {
            name: 'Ada', email: 'internal-id', pendingTasks: [done]
        }, 400);
        await unchanged('/tasks/' + alpha, 'PUT', taskBody('Bad', {
            assignedUser: absentId()
        }), 404);
        await unchanged('/tasks/' + alpha, 'PUT', { name: 'Bad' }, 400);
        await unchanged('/tasks/' + alpha, 'PUT', taskBody('Bad', {
            assignedUser: ada, assignedUserName: 'Bea'
        }), 400);
        await unchanged('/users/bad-id', 'DELETE', undefined, 404);
        await unchanged('/tasks/bad-id', 'DELETE', undefined, 404);
        await unchanged('/users/' + absentId(), 'DELETE', undefined, 404);
        await unchanged('/tasks/' + absentId(), 'DELETE', undefined, 404);
        assert.equal((await request('/users/bad-id')).status, 404);
        assert.equal((await request('/tasks/' + absentId())).status, 404);

        const originalTaskUpdate = Task.updateOne;
        Task.updateOne = async () => { throw new Error('injected Atlas rollback test'); };
        try {
            await unchanged('/users', 'POST', {
                name: 'Rollback', email: 'rollback-id', pendingTasks: [beta]
            }, 500);
        } finally {
            Task.updateOne = originalTaskUpdate;
        }
        const originalTaskReplace = Task.findOneAndReplace;
        Task.findOneAndReplace = async () => {
            throw new Error('injected Atlas rollback test');
        };
        try {
            await unchanged('/tasks/' + alpha, 'PUT', taskBody('Alpha', {
                assignedUser: bea
            }), 500);
        } finally {
            Task.findOneAndReplace = originalTaskReplace;
        }

        result = await request('/tasks/' + beta, 'PUT', taskBody('Beta', {
            assignedUser: ada
        }));
        assert.equal(result.status, 200);
        assert.deepEqual(new Set((await request('/users/' + ada)).data.pendingTasks),
            new Set([alpha, beta]));
        result = await request('/users', 'POST', {
            name: 'Cara', email: 'cara@example.com', pendingTasks: [beta]
        });
        assert.equal(result.status, 201);
        const cara = result.data._id;
        assert.equal((await request('/tasks/' + beta)).data.assignedUser, cara);
        assert.deepEqual((await request('/users/' + ada)).data.pendingTasks, [alpha]);
        result = await request('/users/' + bea, 'PUT', {
            name: 'Bea New', email: 'bea@example.com', pendingTasks: [beta]
        });
        assert.equal(result.status, 200);
        assert.equal((await request('/tasks/' + beta)).data.assignedUserName, 'Bea New');
        assert.equal((await request('/tasks/' + done)).data.assignedUserName, 'Bea New');
        assert.deepEqual((await request('/users/' + cara)).data.pendingTasks, []);

        result = await request('/tasks/' + alpha, 'PUT', taskBody('Alpha', {
            assignedUser: bea, completed: true, dateCreated: '1999-01-01'
        }));
        assert.equal(result.status, 200);
        assert.equal(result.data.dateCreated, alphaCreated);
        assert.equal(result.data.assignedUserName, 'Bea New');
        assert.deepEqual((await request('/users/' + ada)).data.pendingTasks, []);
        assert.deepEqual((await request('/users/' + bea)).data.pendingTasks, [beta]);
        result = await request('/tasks/' + alpha, 'PUT', taskBody('Alpha', {
            assignedUser: bea
        }));
        assert.equal(result.status, 200);
        assert.deepEqual(new Set((await request('/users/' + bea)).data.pendingTasks),
            new Set([beta, alpha]));
        result = await request('/tasks/' + alpha, 'PUT', taskBody('Alpha'));
        assert.equal(result.status, 200);
        assert.equal(result.data.assignedUser, '');
        assert.equal(result.data.assignedUserName, 'unassigned');
        assert.deepEqual((await request('/users/' + bea)).data.pendingTasks, [beta]);

        result = await request('/users/' + ada, 'PUT', {
            name: 'Ada New', email: 'internal-id', pendingTasks: [alpha],
            dateCreated: '1999-01-01'
        });
        assert.equal(result.status, 200);
        assert.equal(result.data.dateCreated, adaCreated);
        assert.equal((await request('/tasks/' + alpha)).data.assignedUserName, 'Ada New');
        result = await request('/users/' + ada, 'PUT', {
            name: 'Ada New', email: 'internal-id'
        });
        assert.equal(result.status, 200);
        assert.deepEqual(result.data.pendingTasks, []);
        assert.equal((await request('/tasks/' + alpha)).data.assignedUser, '');
        result = await request('/tasks/' + alpha, 'PUT', taskBody('Alpha', {
            assignedUser: ada
        }));
        assert.equal(result.status, 200);
        assert.deepEqual((await request('/users/' + ada)).data.pendingTasks, [alpha]);

        assert.equal((await request('/tasks/' + beta, 'DELETE')).status, 204);
        assert.deepEqual((await request('/users/' + bea)).data.pendingTasks, []);
        assert.equal((await request('/tasks/' + beta)).status, 404);
        assert.equal((await request('/users/' + bea, 'DELETE')).status, 204);
        result = await request('/tasks/' + done);
        assert.equal(result.data.assignedUser, '');
        assert.equal(result.data.assignedUserName, 'unassigned');
        assert.equal((await request('/users/' + bea)).status, 404);
        assert.equal((await request('/tasks/' + alpha, 'DELETE')).status, 204);
        assert.equal((await request('/users/' + ada, 'DELETE')).status, 204);
        assert.equal((await request('/users/' + cara, 'DELETE')).status, 204);
        assert.equal((await request('/tasks/' + done, 'DELETE')).status, 204);
        assert.deepEqual((await request('/users')).data, []);
        assert.deepEqual((await request('/tasks')).data, []);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        try {
            if (mongoose.connection.readyState === 1) {
                if (!mongoose.connection.name.startsWith('apied_it_')) {
                    throw new Error('Refusing to drop a database outside the integration test namespace.');
                }
                await mongoose.connection.dropDatabase();
            }
        } finally {
            await mongoose.disconnect();
        }
    }
});
