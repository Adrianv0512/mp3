module.exports = function strictBoolean(value) {
    if (value !== undefined && typeof value !== 'boolean') {
        throw new TypeError('Expected a boolean');
    }
    return value;
};
