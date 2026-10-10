const path = require('node:path');
const Module = require('node:module');
const remasterRoot = path.resolve(__dirname, '..');
process.env.NODE_PATH = [path.join(remasterRoot,'node_modules'),path.resolve(remasterRoot,'../backend/node_modules'),path.resolve(remasterRoot,'../frontend/node_modules')].join(path.delimiter);
Module._initPaths();
