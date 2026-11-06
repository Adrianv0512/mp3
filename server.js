const express = require('express');
const mongoose = require('mongoose');
const User = require('./models/user');
const Task = require('./models/task');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Allow CORS so that backend and frontend can be put on different servers.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
    next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const router = express.Router();
require('./routes')(app, router);

async function start() {
    if (!process.env.MONGODB_URI || process.env.MONGODB_URI.includes('<')) {
        console.error('Set MONGODB_URI in .env before starting the server.');
        process.exitCode = 1;
        return;
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        await Promise.all([User.init(), Task.init()]);
        console.log('Connected to MongoDB.');
        app.listen(port, () => console.log(`Server running on port ${port}`));
    } catch (error) {
        console.error('MongoDB connection failed. Check the Atlas connection string, database user, and network access.');
        process.exitCode = 1;
    }
}

start();
