const mongoose = require('mongoose');
const strictString = require('./strictString');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, set: strictString },
    email: { type: String, required: true, trim: true, unique: true, set: strictString },
    pendingTasks: {
        type: [{ type: String, set: strictString, validate: mongoose.isObjectIdOrHexString }],
        default: [],
        castNonArrays: false
    },
    dateCreated: { type: Date, default: Date.now, immutable: true }
});

userSchema.pre('validate', function () {
    if (this.isNew) this.dateCreated = new Date();
});

module.exports = mongoose.model('User', userSchema);
