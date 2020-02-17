'use strict';

const { Transform } = require('stream');
const crypto = require('crypto');

module.exports = class extends Transform {
    constructor(options) {
        super(options);
        this._hash = crypto.createHash('sha256');
    }

    _transform(data, encoding, callback) {
        this._hash.update(data, encoding);
        callback(null, data);
    }

    digest(encoding) {
        return this._hash.digest(encoding);
    }
};
