const mongoose = require('mongoose');
const strictString = require('./strictString');
const strictBoolean = require('./strictBoolean');

const taskSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, set: strictString },
    description: { type: String, default: '', set: strictString },
    deadline: { type: Date, required: true },
    completed: { type: Boolean, default: false, set: strictBoolean },
    assignedUser: {
        type: String,
        default: '',
        set: strictString,
        validate: value => value === '' || mongoose.isObjectIdOrHexString(value)
    },
    assignedUserName: { type: String, default: 'unassigned', set: strictString },
    dateCreated: { type: Date, default: Date.now, immutable: true }
});

taskSchema.pre('validate', function () {
    if (this.isNew) this.dateCreated = new Date();
});

module.exports = mongoose.model('Task', taskSchema);
