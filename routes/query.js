class QueryParameterError extends Error {}

function jsonObject(parameters, name) {
    if (!Object.hasOwn(parameters, name)) return undefined;
    const raw = parameters[name];
    if (typeof raw !== 'string') throw new QueryParameterError(`Invalid ${name} query parameter.`);

    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new QueryParameterError(`Invalid ${name} query parameter.`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new QueryParameterError(`Invalid ${name} query parameter.`);
    }
    return value;
}

function selection(parameters) {
    const value = jsonObject(parameters, 'select');
    if (value === undefined) return undefined;
    const fields = Object.entries(value);
    if (fields.some(([field, flag]) => !field || (flag !== 0 && flag !== 1))) {
        throw new QueryParameterError('Invalid select query parameter.');
    }
    const ordinaryFlags = fields.filter(([field]) => field !== '_id').map(([, flag]) => flag);
    if (ordinaryFlags.includes(0) && ordinaryFlags.includes(1)) {
        throw new QueryParameterError('Invalid select query parameter.');
    }
    return value;
}

function nonnegativeInteger(parameters, name) {
    if (!Object.hasOwn(parameters, name)) return undefined;
    const raw = parameters[name];
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new QueryParameterError(`Invalid ${name} query parameter.`);
    }
    return Number(raw);
}

function collectionQuery(parameters, defaultLimit) {
    const where = jsonObject(parameters, 'where') || {};
    const sort = jsonObject(parameters, 'sort');
    if (sort && Object.entries(sort).some(([field, direction]) =>
        !field || (direction !== 1 && direction !== -1))) {
        throw new QueryParameterError('Invalid sort query parameter.');
    }

    const select = selection(parameters);
    const skip = nonnegativeInteger(parameters, 'skip') ?? 0;
    const limit = nonnegativeInteger(parameters, 'limit') ?? defaultLimit;
    const count = parameters.count;
    if (count !== undefined && count !== 'true' && count !== 'false') {
        throw new QueryParameterError('Invalid count query parameter.');
    }
    return { where, sort, select, skip, limit, count: count === 'true' };
}

module.exports = { QueryParameterError, collectionQuery, selection };
