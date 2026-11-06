module.exports = function strictString(value) {
    if (value !== undefined && typeof value !== 'string') {
        throw new TypeError('Expected a string');
    }
    return value;
};
