const User = require('../models/user');
const Task = require('../models/task');
const registerResource = require('./resources');

module.exports = function (app, router) {
    router.get('/', (req, res) => res.status(200).json({ message: 'API is running.', data: null }));
    registerResource(router, '/users', User, 'User');
    registerResource(router, '/tasks', Task, 'Task');
    app.use('/api', router);

    app.use((req, res) => res.status(404).json({ message: 'Route not found.', data: null }));
    app.use((error, req, res, next) => {
        if (error.status === 400 && error instanceof SyntaxError) {
            return res.status(400).json({ message: 'Invalid JSON request body.', data: null });
        }
        console.error('Unexpected request error:', error);
        return res.status(500).json({ message: 'Internal server error.', data: null });
    });
};
