const mongoose = require('mongoose');
const { QueryParameterError, collectionQuery, selection } = require('./query');
const references = require('./references');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function validateBody(body, kind) {
    if (!isObject(body)) return null;

    if (kind === 'User') {
        if (!validText(body.name) || !validText(body.email) ||
            !emailPattern.test(body.email.trim())) return null;
        if (body.pendingTasks !== undefined &&
            (!Array.isArray(body.pendingTasks) || !body.pendingTasks.every(
                id => typeof id === 'string' && mongoose.isObjectIdOrHexString(id)
            ))) return null;

        return {
            name: body.name,
            email: body.email,
            ...(body.pendingTasks === undefined ? {} : { pendingTasks: body.pendingTasks })
        };
    }

    if (!validText(body.name) || typeof body.deadline !== 'string' ||
        !body.deadline.trim() || Number.isNaN(Date.parse(body.deadline))) return null;
    if (body.description !== undefined && typeof body.description !== 'string') return null;
    if (body.completed !== undefined && typeof body.completed !== 'boolean') return null;
    if (body.assignedUser !== undefined &&
        (typeof body.assignedUser !== 'string' ||
            (body.assignedUser !== '' && !mongoose.isObjectIdOrHexString(body.assignedUser)))) return null;
    if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string') return null;

    return {
        name: body.name,
        deadline: body.deadline,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.completed === undefined ? {} : { completed: body.completed }),
        ...(body.assignedUser === undefined ? {} : { assignedUser: body.assignedUser }),
        ...(body.assignedUserName === undefined ? {} : { assignedUserName: body.assignedUserName })
    };
}

function sendError(res, error, kind) {
    if (error instanceof references.ReferenceError) {
        return res.status(error.status).json({ message: error.message, data: null });
    }
    if (error && error.code === 11000) {
        return res.status(400).json({ message: 'Email is already in use.', data: null });
    }
    if (error instanceof mongoose.Error.ValidationError ||
        error instanceof mongoose.Error.CastError) {
        return res.status(400).json({ message: `Invalid ${kind.toLowerCase()} data.`, data: null });
    }
    console.error(`Unexpected ${kind.toLowerCase()} API error:`, error);
    return res.status(500).json({ message: 'Internal server error.', data: null });
}

function sendQueryError(res, error, kind) {
    if (error instanceof QueryParameterError) {
        return res.status(400).json({ message: error.message, data: null });
    }
    if (error instanceof mongoose.Error.CastError || error instanceof mongoose.Error.ValidationError) {
        return res.status(400).json({ message: 'Invalid query parameter.', data: null });
    }
    console.error(`Unexpected ${kind.toLowerCase()} query error:`, error);
    return res.status(500).json({ message: 'Internal server error.', data: null });
}

function registerResource(router, path, Model, kind) {
    router.route(path)
        .get(async (req, res) => {
            try {
                const { where, sort, select, skip, limit, count } = collectionQuery(
                    req.query, kind === 'Task' ? 100 : undefined
                );
                if (count) {
                    const total = await Model.countDocuments(where);
                    return res.status(200).json({ message: `${kind}s counted.`, data: total });
                }
                if (limit === 0) {
                    return res.status(200).json({ message: `${kind}s retrieved.`, data: [] });
                }
                let query = Model.find(where);
                if (sort) query = query.sort(sort);
                if (select) query = query.select(select);
                query = query.skip(skip);
                if (limit !== undefined) query = query.limit(limit);
                const documents = await query;
                return res.status(200).json({ message: `${kind}s retrieved.`, data: documents });
            } catch (error) {
                return sendQueryError(res, error, kind);
            }
        })
        .post(async (req, res) => {
            const fields = validateBody(req.body, kind);
            if (!fields) return res.status(400).json({ message: `Invalid ${kind.toLowerCase()} data.`, data: null });

            try {
                const document = kind === 'User'
                    ? await references.createUser(fields)
                    : await references.createTask(fields);
                return res.status(201).json({ message: `${kind} created.`, data: document });
            } catch (error) {
                return sendError(res, error, kind);
            }
        });

    router.route(`${path}/:id`)
        .get(async (req, res) => {
            if (!mongoose.isObjectIdOrHexString(req.params.id)) {
                return res.status(404).json({ message: `${kind} not found.`, data: null });
            }
            try {
                const projection = selection(req.query);
                let query = Model.findById(req.params.id);
                if (projection) query = query.select(projection);
                const document = await query;
                if (!document) return res.status(404).json({ message: `${kind} not found.`, data: null });
                return res.status(200).json({ message: `${kind} retrieved.`, data: document });
            } catch (error) {
                return sendQueryError(res, error, kind);
            }
        })
        .put(async (req, res) => {
            if (!mongoose.isObjectIdOrHexString(req.params.id)) {
                return res.status(404).json({ message: `${kind} not found.`, data: null });
            }
            try {
                const existing = await Model.findById(req.params.id);
                if (!existing) return res.status(404).json({ message: `${kind} not found.`, data: null });

                const fields = validateBody(req.body, kind);
                if (!fields) return res.status(400).json({ message: `Invalid ${kind.toLowerCase()} data.`, data: null });

                const updated = kind === 'User'
                    ? await references.replaceUser(req.params.id, fields)
                    : await references.replaceTask(req.params.id, fields);
                return res.status(200).json({ message: `${kind} replaced.`, data: updated });
            } catch (error) {
                return sendError(res, error, kind);
            }
        })
        .delete(async (req, res) => {
            if (!mongoose.isObjectIdOrHexString(req.params.id)) {
                return res.status(404).json({ message: `${kind} not found.`, data: null });
            }
            try {
                if (kind === 'User') await references.deleteUser(req.params.id);
                else await references.deleteTask(req.params.id);
                return res.status(204).end();
            } catch (error) {
                return sendError(res, error, kind);
            }
        });
}

module.exports = registerResource;
